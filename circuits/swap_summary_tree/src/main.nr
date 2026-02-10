use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};
use dep::protocol_types::hash::poseidon2_hash;

/// Public inputs per child proof:
///   [0] leaf_or_root
///   [1] vkey_marker
///   [2] value_in
///   [3] value_out
///   [4] price_feed_address

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof_left: UltraHonkZKProof,
    proof_right: Option<UltraHonkZKProof>,
    public_inputs_left: [Field; 5],
    public_inputs_right: Option<[Field; 5]>,
    zero_leaf_hint: Option<Field>,
    // The expected leaf circuit vkey hash (for level 0 validation)
    leaf_vkey_hash: Field,
    // Summary circuit vkey hash - passed through for chaining
    summary_vkey_hash: Field,
) -> pub (Field, Field, Field, Field, Field) {
    // 1. Verify left proof (always present)
    verify_honk_proof(verification_key, proof_left, public_inputs_left, vkey_hash);

    // 2. Extract values from left proof
    let left_node = public_inputs_left[0];
    let left_vkey_marker = public_inputs_left[1];
    let left_value_in = public_inputs_left[2];
    let left_value_out = public_inputs_left[3];
    let left_price_feed = public_inputs_left[4];

    // 3. Handle right proof (if present) or use zero padding
    let mut right_node = 0;
    let mut right_value_in = 0;
    let mut right_value_out = 0;

    if proof_right.is_some() {
        let right_inputs = public_inputs_right.unwrap();
        verify_honk_proof(verification_key, proof_right.unwrap(), right_inputs, vkey_hash);
        right_node = right_inputs[0];
        right_value_in = right_inputs[2];
        right_value_out = right_inputs[3];
        // Ensure left and right have same vkey marker
        assert(right_inputs[1] == left_vkey_marker, "vkey marker mismatch between left and right proofs");
        // Ensure same price feed address
        assert(right_inputs[4] == left_price_feed, "price feed address mismatch between left and right proofs");
    } else {
        right_node = zero_leaf_hint.unwrap();
        // Padding: value_in and value_out stay 0
    }

    // 4. VKey validation based on marker
    if left_vkey_marker == 0 {
        // Level 0: verifying leaf proofs - check against provided leaf vkey hash
        assert(vkey_hash == leaf_vkey_hash, "Invalid leaf vkey hash");
    } else {
        // Level 1+: verifying summary proofs
        assert(left_vkey_marker == vkey_hash, "vkey chain mismatch");
        assert(vkey_hash == summary_vkey_hash, "vkey hash inconsistent with summary_vkey_hash");
    }

    // 5. Hash the nodes into merkle root
    let root = poseidon2_hash([left_node, right_node]);

    // 6. Sum PnL values
    let total_value_in = left_value_in + right_value_in;
    let total_value_out = left_value_out + right_value_out;

    // 7. Output: (root, summary_vkey_hash, total_value_in, total_value_out, price_feed_address)
    (root, summary_vkey_hash, total_value_in, total_value_out, left_price_feed)
}
