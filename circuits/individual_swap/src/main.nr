mod utils;

use dep::protocol_types::hash::poseidon2_hash;
use utils::{
    PLAINTEXT_BYTES_LEN, CIPHERTEXT_BYTES_LEN, MAX_LOTS,
    Lot, PriceWitness,
    compute_public_data_tree_index,
    derive_storage_slot_in_map,
    extract_plaintext_field,
    hash_lots,
    verify_and_read_public_data,
    verify_encryption,
};

/// Proves a single swap event and computes FIFO capital gains for a tracked token.
/// Uses i64 arithmetic for PnL to safely handle negative gains (losses).
///
/// Oracle prices must have at most 4 decimal precision (scaled by 10^4).
/// Token amounts must fit in i64 (< 9.2 * 10^18). With 4-decimal prices,
/// amount * price products fit safely in i64 for any realistic values.
///
/// Returns: (leaf_hash, pnl, pnl_is_negative, remaining_lots_hash, initial_lots_hash, price_feed_address)
fn main(
    // Swap event
    plaintext_bytes: [u8; PLAINTEXT_BYTES_LEN],
    eph_pk_x: Field,
    ciphertext_bytes: [u8; CIPHERTEXT_BYTES_LEN],
    ivsk_app: Field,
    block_number: Field,

    // Token identification (the token whose lots we track)
    token_address: Field,

    // Oracle price data (only the tracked token's price)
    price_feed_address: Field,
    price_feed_assets_slot: Field,
    public_data_tree_root: Field,
    price_witness: PriceWitness,

    // FIFO lot state from previous proof
    initial_lots: [Lot; MAX_LOTS],
    initial_num_lots: u32,
) -> pub (Field, Field, Field, Field, Field, Field) {
    // 1. Verify encryption (proves swap event is authentic)
    verify_encryption(plaintext_bytes, eph_pk_x, ciphertext_bytes, ivsk_app);

    // 2. Extract swap values from plaintext
    // Layout: [metadata, randomness, token_in, token_out, amount_in, amount_out, is_exact_input]
    let token_in = extract_plaintext_field(plaintext_bytes, 2);
    let token_out = extract_plaintext_field(plaintext_bytes, 3);
    let amount_in = extract_plaintext_field(plaintext_bytes, 4);
    let amount_out = extract_plaintext_field(plaintext_bytes, 5);
    let is_exact_input = extract_plaintext_field(plaintext_bytes, 6);

    // 3. Compute leaf hash (commits to the raw swap data)
    let leaf = poseidon2_hash(
        [block_number, token_in, token_out, amount_in, amount_out, is_exact_input],
    );

    // 4. Determine direction (does the tracked token appear as in or out?)
    let is_buy = (token_out == token_address);
    let is_sell = (token_in == token_address);
    assert(is_buy | is_sell, "Swap does not involve tracked token");

    // 5. Read oracle price for TOKEN at this block
    let token_slot = derive_storage_slot_in_map(price_feed_assets_slot, token_address);
    let tree_index = compute_public_data_tree_index(price_feed_address, token_slot);
    let token_price = verify_and_read_public_data(
        public_data_tree_root, tree_index, price_witness,
    );
    assert(token_price != 0, "Token price must not be zero");

    // 6. Hash initial lot state (for chaining verification)
    let initial_lots_hash = hash_lots(initial_lots, initial_num_lots);

    // 7. Process swap: update FIFO lots and compute gains using i64 arithmetic
    let mut lots = initial_lots;
    let mut num_lots = initial_num_lots;
    let mut pnl: i64 = 0;

    if is_buy {
        // BUY: acquired the tracked token
        // Create a new lot at current oracle price
        assert((num_lots as u64) < (MAX_LOTS as u64), "Lot array full");
        lots[num_lots] = Lot { amount: amount_out, cost_per_unit: token_price };
        num_lots += 1;
    } else {
        // SELL: disposed of the tracked token
        // Consume lots FIFO, accumulate signed PnL
        let sell_price: i64 = token_price as i64;
        let mut remaining: i64 = amount_in as i64;

        for j in 0..MAX_LOTS {
            let lot_amount: i64 = lots[j].amount as i64;
            let lot_cost: i64 = lots[j].cost_per_unit as i64;

            if (remaining != 0) & (lot_amount != 0) {
                let consumed: i64 = if remaining < lot_amount { remaining } else { lot_amount };

                let proceeds = consumed * sell_price;
                let cost = consumed * lot_cost;
                pnl += proceeds - cost;

                lots[j].amount = (lot_amount - consumed) as u64 as Field;
                remaining -= consumed;
            }
        }
        assert(remaining == 0, "Not enough lots to cover sell amount");

        // Compact: shift non-empty lots to the front so empty slots can be reused
        let mut compacted: [Lot; MAX_LOTS] = [Lot { amount: 0, cost_per_unit: 0 }; MAX_LOTS];
        let mut write_idx: u32 = 0;
        for j in 0..MAX_LOTS {
            if lots[j].amount != 0 {
                compacted[write_idx] = lots[j];
                write_idx += 1;
            }
        }
        lots = compacted;
        num_lots = write_idx;
    }

    // 8. Hash remaining lot state (for chaining to next proof)
    let remaining_lots_hash = hash_lots(lots, num_lots);

    // 9. Encode signed PnL as (magnitude, is_negative) for Field output
    let pnl_is_negative: Field = if pnl < 0 { 1 } else { 0 };
    let pnl_abs: Field = if pnl < 0 { (-pnl) as u64 as Field } else { pnl as u64 as Field };

    (leaf, pnl_abs, pnl_is_negative, remaining_lots_hash, initial_lots_hash, price_feed_address)
}
