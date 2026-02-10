mod utils;

use dep::protocol_types::{
    hash::poseidon2_hash,
    merkle_tree::root::root_from_sibling_path,
};
use utils::{
    PLAINTEXT_BYTES_LEN, CIPHERTEXT_BYTES_LEN, MAX_LOTS, LOT_TREE_HEIGHT,
    Lot, PriceWitness,
    compute_public_data_tree_index,
    derive_storage_slot_in_map,
    extract_plaintext_field,
    hash_lots,
    verify_and_read_public_data,
    verify_encryption,
};

/// Proves a single swap event and computes FIFO capital gains across a multi-token lot state tree.
/// Each swap updates two leaves: sell-side (token_in) and buy-side (token_out).
///
/// Oracle prices must have at most 4 decimal precision (scaled by 10^4).
/// Token amounts must fit in i64 (< 9.2 * 10^18).
///
/// Returns: (leaf_hash, pnl_abs, pnl_is_negative, remaining_lot_state_root, initial_lot_state_root, price_feed_address, block_number)
fn main(
    // Swap event
    plaintext_bytes: [u8; PLAINTEXT_BYTES_LEN],
    eph_pk_x: Field,
    ciphertext_bytes: [u8; CIPHERTEXT_BYTES_LEN],
    ivsk_app: Field,
    block_number: Field,

    // Lot state tree root (before this swap)
    initial_lot_state_root: Field,

    // Sell-side token (token_in)
    sell_lots: [Lot; MAX_LOTS],
    sell_num_lots: u32,
    sell_leaf_index: Field,
    sell_sibling_path: [Field; LOT_TREE_HEIGHT],

    // Buy-side token (token_out)
    buy_lots: [Lot; MAX_LOTS],
    buy_num_lots: u32,
    buy_leaf_index: Field,
    buy_sibling_path: [Field; LOT_TREE_HEIGHT], // against INTERMEDIATE root (after sell update)

    // Oracle prices for BOTH tokens
    price_feed_address: Field,
    price_feed_assets_slot: Field,
    public_data_tree_root: Field,
    sell_price_witness: PriceWitness,
    buy_price_witness: PriceWitness,

    // Chronological ordering
    previous_block_number: Field,
) -> pub (Field, Field, Field, Field, Field, Field, Field) {
    // 1. Verify encryption (proves swap event is authentic)
    verify_encryption(plaintext_bytes, eph_pk_x, ciphertext_bytes, ivsk_app);

    // 2. Extract swap values from plaintext
    // Layout: [metadata, randomness, token_in, token_out, amount_in, amount_out, is_exact_input]
    let token_in = extract_plaintext_field(plaintext_bytes, 2);
    let token_out = extract_plaintext_field(plaintext_bytes, 3);
    let amount_in = extract_plaintext_field(plaintext_bytes, 4);
    let amount_out = extract_plaintext_field(plaintext_bytes, 5);
    let is_exact_input = extract_plaintext_field(plaintext_bytes, 6);

    // 3. Assert chronological ordering
    let bn: u64 = block_number as u64;
    let prev_bn: u64 = previous_block_number as u64;
    assert(bn >= prev_bn, "Block number must be >= previous block number");

    // 4. Compute leaf hash (commits to the raw swap data)
    let leaf = poseidon2_hash(
        [block_number, token_in, token_out, amount_in, amount_out, is_exact_input],
    );

    // 5. SELL SIDE: Verify sell lots in initial root, consume FIFO, compute PnL
    let old_sell_hash = hash_lots(token_in, sell_lots, sell_num_lots);
    let computed_initial_root = root_from_sibling_path(old_sell_hash, sell_leaf_index, sell_sibling_path);
    assert_eq(computed_initial_root, initial_lot_state_root, "Sell-side merkle proof failed against initial root");

    // Read sell token oracle price
    let sell_token_slot = derive_storage_slot_in_map(price_feed_assets_slot, token_in);
    let sell_tree_index = compute_public_data_tree_index(price_feed_address, sell_token_slot);
    let sell_price = verify_and_read_public_data(
        public_data_tree_root, sell_tree_index, sell_price_witness,
    );
    assert(sell_price != 0, "Sell token price must not be zero");

    // Consume sell-side lots FIFO with i64 PnL
    let mut sell_lots_mut = sell_lots;
    let mut sell_num = sell_num_lots;
    let mut pnl: i64 = 0;

    let sell_price_i64: i64 = sell_price as i64;
    let mut remaining: i64 = amount_in as i64;

    for j in 0..MAX_LOTS {
        let lot_amount: i64 = sell_lots_mut[j].amount as i64;
        let lot_cost: i64 = sell_lots_mut[j].cost_per_unit as i64;

        if (remaining != 0) & (lot_amount != 0) {
            let consumed: i64 = if remaining < lot_amount { remaining } else { lot_amount };

            let proceeds = consumed * sell_price_i64;
            let cost = consumed * lot_cost;
            pnl += proceeds - cost;

            sell_lots_mut[j].amount = (lot_amount - consumed) as u64 as Field;
            remaining -= consumed;
        }
    }
    assert(remaining == 0, "Not enough lots to cover sell amount");

    // Compact sell lots
    let mut compacted_sell: [Lot; MAX_LOTS] = [Lot { amount: 0, cost_per_unit: 0 }; MAX_LOTS];
    let mut write_idx: u32 = 0;
    for j in 0..MAX_LOTS {
        if sell_lots_mut[j].amount != 0 {
            compacted_sell[write_idx] = sell_lots_mut[j];
            write_idx += 1;
        }
    }
    sell_num = write_idx;

    // 6. Compute intermediate root (after sell update)
    let new_sell_hash = hash_lots(token_in, compacted_sell, sell_num);
    let intermediate_root = root_from_sibling_path(new_sell_hash, sell_leaf_index, sell_sibling_path);

    // 7. BUY SIDE: Verify buy lots in intermediate root, add new lot
    let old_buy_hash = hash_lots(token_out, buy_lots, buy_num_lots);
    let computed_intermediate_root = root_from_sibling_path(old_buy_hash, buy_leaf_index, buy_sibling_path);
    assert_eq(computed_intermediate_root, intermediate_root, "Buy-side merkle proof failed against intermediate root");

    // Read buy token oracle price
    let buy_token_slot = derive_storage_slot_in_map(price_feed_assets_slot, token_out);
    let buy_tree_index = compute_public_data_tree_index(price_feed_address, buy_token_slot);
    let buy_price = verify_and_read_public_data(
        public_data_tree_root, buy_tree_index, buy_price_witness,
    );
    assert(buy_price != 0, "Buy token price must not be zero");

    // Add new lot on buy side
    let mut buy_lots_mut = buy_lots;
    let mut buy_num = buy_num_lots;
    assert((buy_num as u64) < (MAX_LOTS as u64), "Buy lot array full");
    buy_lots_mut[buy_num] = Lot { amount: amount_out, cost_per_unit: buy_price };
    buy_num += 1;

    // 8. Compute final root (after buy update)
    let new_buy_hash = hash_lots(token_out, buy_lots_mut, buy_num);
    let final_root = root_from_sibling_path(new_buy_hash, buy_leaf_index, buy_sibling_path);

    // 9. Encode signed PnL as (magnitude, is_negative) for Field output
    let pnl_is_negative: Field = if pnl < 0 { 1 } else { 0 };
    let pnl_abs: Field = if pnl < 0 { (-pnl) as u64 as Field } else { pnl as u64 as Field };

    (leaf, pnl_abs, pnl_is_negative, final_root, initial_lot_state_root, price_feed_address, block_number)
}
