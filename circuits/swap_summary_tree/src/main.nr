use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};
use dep::protocol_types::hash::poseidon2_hash;

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof_left: UltraHonkZKProof,
    proof_right: Option<UltraHonkZKProof>,
    // Public inputs from each proof: [leaf_hash, vkey_marker]
    public_inputs_left: [Field; 2],
    public_inputs_right: Option<[Field; 2]>,
    zero_leaf_hint: Option<Field>,
    // The expected leaf circuit vkey hash (for level 0 validation)
    leaf_vkey_hash: Field,
    // Summary circuit vkey hash - passed through for chaining
    summary_vkey_hash: Field,
) -> pub (Field, Field) {
    // 1. Verify left proof (always present)
    verify_honk_proof(verification_key, proof_left, public_inputs_left, vkey_hash);

    // 2. Extract values from left proof
    let left_node = public_inputs_left[0];
    let left_vkey_marker = public_inputs_left[1];

    // 3. Verify right proof (if present) and extract node value
    let mut right_node = 0;
    if proof_right.is_some() {
        let right_inputs = public_inputs_right.unwrap();
        verify_honk_proof(verification_key, proof_right.unwrap(), right_inputs, vkey_hash);
        right_node = right_inputs[0];
        // Ensure left and right have same vkey marker
        assert(right_inputs[1] == left_vkey_marker, "vkey marker mismatch between left and right proofs");
    } else {
        right_node = zero_leaf_hint.unwrap();
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

    // 6. Output: (root, summary_vkey_hash)
    (root, summary_vkey_hash)
}
