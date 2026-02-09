use dep::protocol_types::{
    constants::GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
    merkle_tree::root::root_from_sibling_path,
    utils::field::full_field_less_than,
};

/// Public data tree height in Aztec
global PUBLIC_DATA_TREE_HEIGHT: u32 = 40;

/// Preimage of a public data tree leaf (indexed tree)
struct PublicDataLeafPreimage {
    slot: Field,
    value: Field,
    next_slot: Field,
    next_index: Field,
}

impl PublicDataLeafPreimage {
    fn hash(self) -> Field {
        let is_empty = (self.slot == 0) & (self.value == 0) & (self.next_slot == 0) & (self.next_index == 0);
        if is_empty {
            0
        } else {
            poseidon2_hash([self.slot, self.value, self.next_index, self.next_slot])
        }
    }
}

/// Compute the public data tree leaf index for a storage slot in a contract.
/// This "silos" the slot with the contract address using poseidon2 with a generator separator.
fn compute_public_data_tree_index(contract_address: Field, storage_slot: Field) -> Field {
    poseidon2_hash_with_separator(
        [contract_address, storage_slot],
        GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
    )
}

/// Derive the storage slot for a map entry: hash(map_slot, key)
fn derive_storage_slot_in_map(storage_slot: Field, key: Field) -> Field {
    poseidon2_hash([storage_slot, key])
}

/// Verify a public data tree Merkle membership proof and extract the stored value.
/// Returns the value at the given tree_index, or 0 if the slot was never written.
fn verify_and_read_public_data(
    public_data_tree_root: Field,
    tree_index: Field,
    leaf_preimage: PublicDataLeafPreimage,
    witness_index: Field,
    witness_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
) -> Field {
    // 1. Verify the leaf exists in the tree
    let leaf_hash = leaf_preimage.hash();
    let computed_root = root_from_sibling_path(leaf_hash, witness_index, witness_path);
    assert_eq(computed_root, public_data_tree_root, "Merkle membership proof failed");

    // 2. Determine the value using indexed tree logic
    let is_less_than_slot = full_field_less_than(leaf_preimage.slot, tree_index);
    let is_next_greater_than = full_field_less_than(tree_index, leaf_preimage.next_slot);
    let is_max = (leaf_preimage.next_index == 0) & (leaf_preimage.next_slot == 0);
    let is_in_range = is_less_than_slot & (is_next_greater_than | is_max);

    if is_in_range {
        // Slot was never written - default value is 0
        0
    } else {
        // Slot exists - leaf preimage directly contains the value
        assert_eq(leaf_preimage.slot, tree_index, "Public data tree index doesn't match witness");
        leaf_preimage.value
    }
}

/// Spot price proof circuit.
///
/// Proves the spot price of an AMM (Uniswap V2 constant-product) at a specific historical block
/// by verifying the public balances of the AMM in each token contract's public data tree.
///
/// Returns: (price, block_number, public_data_tree_root, amm_address, token0_address, token1_address)
fn main(
    // Addresses
    amm_address: Field,
    token0_address: Field,
    token1_address: Field,
    // Block context
    block_number: Field,
    public_data_tree_root: Field,
    // Storage slot of `public_balances` map in the Token contract (varies by contract version)
    token_public_balances_slot: Field,
    // Token0 witness
    token0_leaf_preimage: PublicDataLeafPreimage,
    token0_witness_index: Field,
    token0_witness_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
    // Token1 witness
    token1_leaf_preimage: PublicDataLeafPreimage,
    token1_witness_index: Field,
    token1_witness_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
    // Price computation parameter
    price_precision: Field,
) -> pub (Field, Field, Field, Field, Field, Field) {
    // 1. Derive storage slots
    // Token contract stores public_balances as a Map<AztecAddress, u128>.
    // The derived slot for a specific key is: poseidon2_hash([map_slot, key])
    let token0_map_slot = derive_storage_slot_in_map(token_public_balances_slot, amm_address);
    let token1_map_slot = derive_storage_slot_in_map(token_public_balances_slot, amm_address);

    // Silo with contract address to get the public data tree index
    let token0_tree_index = compute_public_data_tree_index(token0_address, token0_map_slot);
    let token1_tree_index = compute_public_data_tree_index(token1_address, token1_map_slot);

    // 2. Verify Merkle membership and extract balances
    let balance0 = verify_and_read_public_data(
        public_data_tree_root,
        token0_tree_index,
        token0_leaf_preimage,
        token0_witness_index,
        token0_witness_path,
    );

    let balance1 = verify_and_read_public_data(
        public_data_tree_root,
        token1_tree_index,
        token1_leaf_preimage,
        token1_witness_index,
        token1_witness_path,
    );

    // 3. Compute spot price: price = balance1 * precision / balance0
    // Caller must ensure balance0 != 0 (AMM has liquidity)
    assert(balance0 != 0, "AMM has no liquidity for token0");
    let price = balance1 * price_precision / balance0;

    // 4. Return public outputs
    (price, block_number, public_data_tree_root, amm_address, token0_address, token1_address)
}
