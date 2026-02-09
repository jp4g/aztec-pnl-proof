use dep::protocol_types::{
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
    merkle_tree::root::root_from_sibling_path,
    utils::field::full_field_less_than,
};

// Tree heights
global NOTE_HASH_TREE_HEIGHT: u32 = 42;
global NULLIFIER_TREE_HEIGHT: u32 = 42;

// Generator indices (from protocol constants)
global GENERATOR_INDEX__NOTE_HASH: u32 = 1;
global GENERATOR_INDEX__UNIQUE_NOTE_HASH: u32 = 3;
global GENERATOR_INDEX__SILOED_NOTE_HASH: u32 = 4;
global GENERATOR_INDEX__OUTER_NULLIFIER: u32 = 7;
global GENERATOR_INDEX__NOTE_NULLIFIER: u32 = 53;

/// Preimage of a nullifier tree leaf (indexed tree)
struct NullifierLeafPreimage {
    nullifier: Field,
    next_nullifier: Field,
    next_index: Field,
}

impl NullifierLeafPreimage {
    fn hash(self) -> Field {
        let is_empty = (self.nullifier == 0) & (self.next_nullifier == 0) & (self.next_index == 0);
        if is_empty {
            0
        } else {
            poseidon2_hash([self.nullifier, self.next_nullifier, self.next_index])
        }
    }
}

/// Prove that a private token note (UintNote) was created after a specific block,
/// still exists at a later block, and has not been nullified.
///
/// Returns: (note_value, before_block_number, inclusion_block_number,
///           contract_address, note_hash_tree_root, nullifier_tree_root)
fn main(
    // Note data
    note_value: Field,
    owner: Field,
    storage_slot: Field,
    randomness: Field,
    note_nonce: Field,
    contract_address: Field,
    // Block references
    before_block_number: Field,
    before_tree_size: Field,
    inclusion_block_number: Field,
    // Note hash tree state at inclusion block
    note_hash_tree_root: Field,
    // Note inclusion witness
    note_leaf_index: Field,
    note_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
    // Nullifier non-inclusion data at inclusion block
    nsk_app: Field,
    nullifier_tree_root: Field,
    low_nullifier_preimage: NullifierLeafPreimage,
    low_nullifier_index: Field,
    low_nullifier_path: [Field; NULLIFIER_TREE_HEIGHT],
) -> pub (Field, Field, Field, Field, Field, Field) {
    // 1. Compute unique_note_hash (the 4-step hash chain for UintNote)
    // Step 1: partial_commitment = poseidon2([owner, storage_slot, randomness], separator=1)
    let commitment = poseidon2_hash_with_separator(
        [owner, storage_slot, randomness],
        GENERATOR_INDEX__NOTE_HASH,
    );

    // Step 2: note_hash = poseidon2([commitment, value], separator=1)
    let note_hash = poseidon2_hash_with_separator(
        [commitment, note_value],
        GENERATOR_INDEX__NOTE_HASH,
    );

    // Step 3: siloed_note_hash = poseidon2([contract_address, note_hash], separator=4)
    let siloed_note_hash = poseidon2_hash_with_separator(
        [contract_address, note_hash],
        GENERATOR_INDEX__SILOED_NOTE_HASH,
    );

    // Step 4: unique_note_hash = poseidon2([note_nonce, siloed_note_hash], separator=3)
    let unique_note_hash = poseidon2_hash_with_separator(
        [note_nonce, siloed_note_hash],
        GENERATOR_INDEX__UNIQUE_NOTE_HASH,
    );

    // 2. INCLUSION: verify Merkle membership of unique_note_hash in note hash tree
    let computed_root = root_from_sibling_path(
        unique_note_hash,
        note_leaf_index,
        note_sibling_path,
    );
    assert_eq(computed_root, note_hash_tree_root, "Note hash tree inclusion proof failed");

    // 3. NON-INCLUSION AT BEFORE BLOCK: note didn't exist at the earlier block
    // The note hash tree is append-only, so if note_leaf_index >= before_tree_size,
    // the note was not yet in the tree at before_block_number.
    let note_created_after = full_field_less_than(before_tree_size, note_leaf_index)
        | (before_tree_size == note_leaf_index);
    assert(note_created_after, "Note existed before the specified block");

    // 4. ORDERING: before_block < inclusion_block
    assert(
        full_field_less_than(before_block_number, inclusion_block_number),
        "before_block_number must be less than inclusion_block_number",
    );

    // 5. NULLIFIER NON-INCLUSION: prove the note has not been spent
    // Step 5a: Compute the siloed nullifier
    let inner_nullifier = poseidon2_hash_with_separator(
        [unique_note_hash, nsk_app],
        GENERATOR_INDEX__NOTE_NULLIFIER,
    );
    let siloed_nullifier = poseidon2_hash_with_separator(
        [contract_address, inner_nullifier],
        GENERATOR_INDEX__OUTER_NULLIFIER,
    );

    // Step 5b: Verify the low nullifier leaf exists in the nullifier tree
    let low_leaf_hash = low_nullifier_preimage.hash();
    let computed_nullifier_root = root_from_sibling_path(
        low_leaf_hash,
        low_nullifier_index,
        low_nullifier_path,
    );
    assert_eq(
        computed_nullifier_root,
        nullifier_tree_root,
        "Nullifier tree membership proof failed",
    );

    // Step 5c: Assert the siloed nullifier falls in the gap (non-inclusion in indexed tree)
    // The low nullifier's value must be less than our nullifier
    assert(
        full_field_less_than(low_nullifier_preimage.nullifier, siloed_nullifier),
        "Low nullifier is not less than target nullifier",
    );

    // And either: the next nullifier is greater than ours, or this is the max leaf
    let is_next_greater = full_field_less_than(siloed_nullifier, low_nullifier_preimage.next_nullifier);
    let is_max = (low_nullifier_preimage.next_index == 0) & (low_nullifier_preimage.next_nullifier == 0);
    assert(
        is_next_greater | is_max,
        "Nullifier non-inclusion check failed: nullifier not in gap",
    );

    // 6. Return public outputs
    (
        note_value,
        before_block_number,
        inclusion_block_number,
        contract_address,
        note_hash_tree_root,
        nullifier_tree_root,
    )
}
