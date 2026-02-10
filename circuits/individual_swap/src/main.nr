mod utils;

use dep::protocol_types::hash::poseidon2_hash;
use utils::{
    PLAINTEXT_BYTES_LEN, CIPHERTEXT_BYTES_LEN,
    PriceWitness,
    compute_public_data_tree_index,
    derive_storage_slot_in_map,
    extract_plaintext_field,
    verify_and_read_public_data,
    verify_encryption,
};

global MAX_SWAPS: u32 = 8;

fn main(
    num_swaps: u32,
    plaintext_bytes: [[u8; PLAINTEXT_BYTES_LEN]; MAX_SWAPS],
    eph_pk_x: [Field; MAX_SWAPS],
    ciphertext_bytes: [[u8; CIPHERTEXT_BYTES_LEN]; MAX_SWAPS],
    ivsk_app: Field,
    block_numbers: [Field; MAX_SWAPS],
    price_feed_address: Field,
    price_feed_assets_slot: Field,
    public_data_tree_roots: [Field; MAX_SWAPS],
    price_witnesses: [[PriceWitness; 2]; MAX_SWAPS],
) -> pub (Field, Field, Field, Field, Field) {
    assert(num_swaps as u64 <= MAX_SWAPS as u64, "num_swaps exceeds MAX_SWAPS");
    assert(num_swaps as u64 > 0, "num_swaps must be at least 1");

    let mut leaves = [0 as Field; MAX_SWAPS];
    let mut total_value_in: Field = 0;
    let mut total_value_out: Field = 0;

    for i in 0..MAX_SWAPS {
        let active = i < num_swaps;

        if active {
            // 1. Verify encryption
            verify_encryption(plaintext_bytes[i], eph_pk_x[i], ciphertext_bytes[i], ivsk_app);

            // 2. Extract swap values from plaintext bytes
            // Layout: [metadata, randomness, token_in, token_out, amount_in, amount_out, is_exact_input]
            let token_in = extract_plaintext_field(plaintext_bytes[i], 2);
            let token_out = extract_plaintext_field(plaintext_bytes[i], 3);
            let amount_in = extract_plaintext_field(plaintext_bytes[i], 4);
            let amount_out = extract_plaintext_field(plaintext_bytes[i], 5);
            let is_exact_input = extract_plaintext_field(plaintext_bytes[i], 6);

            // 3. Compute leaf hash
            leaves[i] = poseidon2_hash(
                [block_numbers[i], token_in, token_out, amount_in, amount_out, is_exact_input],
            );

            // 4. Verify prices and accumulate values
            let slot_in = derive_storage_slot_in_map(price_feed_assets_slot, token_in);
            let slot_out = derive_storage_slot_in_map(price_feed_assets_slot, token_out);
            let tree_index_in = compute_public_data_tree_index(price_feed_address, slot_in);
            let tree_index_out = compute_public_data_tree_index(price_feed_address, slot_out);

            let price_in = verify_and_read_public_data(
                public_data_tree_roots[i], tree_index_in, price_witnesses[i][0],
            );
            let price_out = verify_and_read_public_data(
                public_data_tree_roots[i], tree_index_out, price_witnesses[i][1],
            );

            assert(price_in != 0, "price_in must not be zero");
            assert(price_out != 0, "price_out must not be zero");

            total_value_in += amount_in * price_in;
            total_value_out += amount_out * price_out;
        }
        // Inactive slots: leaves[i] stays 0, values unchanged
    }

    // Build 3-level merkle tree from 8 leaves
    let mut level1 = [0 as Field; 4];
    for i in 0..4 {
        level1[i] = poseidon2_hash([leaves[i * 2], leaves[i * 2 + 1]]);
    }
    let mut level2 = [0 as Field; 2];
    for i in 0..2 {
        level2[i] = poseidon2_hash([level1[i * 2], level1[i * 2 + 1]]);
    }
    let root = poseidon2_hash([level2[0], level2[1]]);

    (root, 0, total_value_in, total_value_out, price_feed_address)
}
