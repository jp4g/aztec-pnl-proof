use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};
use dep::protocol_types::hash::poseidon2_hash;

/// Public inputs per child proof (6 Fields):
///   [0] leaf_or_root              - leaf hash (individual) or merkle root (summary)
///   [1] pnl                       - signed PnL (i64 encoded as Field)
///   [2] remaining_lot_state_root  - lot state tree root after this proof
///   [3] initial_lot_state_root    - lot state tree root before this proof
///   [4] price_feed_address
///   [5] block_number              - block number (max for summaries)

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof_left: UltraHonkZKProof,
    proof_right: Option<UltraHonkZKProof>,
    public_inputs_left: [Field; 6],
    public_inputs_right: Option<[Field; 6]>,
    zero_leaf_hint: Option<Field>,
    // The expected leaf circuit vkey hash (for level 0 validation)
    leaf_vkey_hash: Field,
    // Summary circuit vkey hash - passed through for chaining
    summary_vkey_hash: Field,
) -> pub (Field, i64, Field, Field, Field, Field) {
    // 1. Verify left proof (always present)
    verify_honk_proof(verification_key, proof_left, public_inputs_left, vkey_hash);

    // 2. Extract values from left proof
    let left_node = public_inputs_left[0];
    let left_pnl: i64 = public_inputs_left[1] as i64;
    let left_remaining_lots = public_inputs_left[2];
    let left_initial_lots = public_inputs_left[3];
    let left_price_feed = public_inputs_left[4];
    let left_block = public_inputs_left[5];

    // 3. Handle right proof (if present) or use zero padding
    let mut right_node: Field = 0;
    let mut right_pnl: i64 = 0;
    let mut right_remaining_lots: Field = 0;
    let mut right_initial_lots: Field = 0;
    let mut right_block: Field = 0;

    if proof_right.is_some() {
        let right_inputs = public_inputs_right.unwrap();
        verify_honk_proof(verification_key, proof_right.unwrap(), right_inputs, vkey_hash);

        right_node = right_inputs[0];
        right_pnl = right_inputs[1] as i64;
        right_remaining_lots = right_inputs[2];
        right_initial_lots = right_inputs[3];
        right_block = right_inputs[5];

        // Ensure same price feed address
        assert(right_inputs[4] == left_price_feed, "price feed address mismatch");

        // 4. Verify lot state root chain: left's remaining must equal right's initial
        assert(
            left_remaining_lots == right_initial_lots,
            "lot state root chain broken: left remaining != right initial",
        );

        // 5. Verify chronological ordering: left block <= right block
        let left_bn: u64 = left_block as u64;
        let right_bn: u64 = right_block as u64;
        assert(left_bn <= right_bn, "Block ordering violated: left > right");
    } else {
        right_node = zero_leaf_hint.unwrap();
        // right_pnl stays 0
        // For padding: right's initial lots = left's remaining lots (trivial chain)
        right_remaining_lots = left_remaining_lots;
        right_initial_lots = left_remaining_lots;
        right_block = left_block;
    }

    // 6. VKey validation based on level
    if vkey_hash == leaf_vkey_hash {
        // Level 0: verifying individual swap proofs
    } else {
        // Level 1+: verifying summary proofs
        assert(vkey_hash == summary_vkey_hash, "vkey hash inconsistent with summary_vkey_hash");
    }

    // 7. Hash the nodes into merkle root
    let root = poseidon2_hash([left_node, right_node]);

    // 8. Sum signed PnL
    let total_pnl: i64 = left_pnl + right_pnl;

    // 9. Output: chain endpoints are left's initial and right's remaining
    // block_number = right's block (max of the pair)
    (root, total_pnl, right_remaining_lots, left_initial_lots, left_price_feed, right_block)
}
