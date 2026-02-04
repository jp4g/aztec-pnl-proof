use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};
use poseidon::poseidon2::Poseidon2;

pub global LEAF_VKEY_HASH: Field = 0x16d556ee92c1493687aae370de818866d826a5225e9a426bb482015cd153f36f;

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof_left: UltraHonkZKProof,
    proof_right: Option<UltraHonkZKProof>,
    // Public inputs from each proof: [value, tree_leaf, vkey_marker]
    public_inputs_left: [Field; 3],
    public_inputs_right: Option<[Field; 3]>,
    zero_leaf_hint: Option<Field>,
    // Summary circuit vkey hash - passed through for chaining
    summary_vkey_hash: Field
) -> pub (Field, Field, Field) {
    // 1. Verify left proof
    verify_honk_proof(verification_key, proof_left, public_inputs_left, vkey_hash);

    // 2. Extract values from left proof
    let left_amount = public_inputs_left[0];
    let left_leaf = public_inputs_left[1];
    let left_vkey_marker = public_inputs_left[2];

    // 3. Verify right proof (if present) and extract values
    let mut right_amount = 0;
    let mut right_leaf = 0;
    if proof_right.is_some() {
        let right_inputs = public_inputs_right.unwrap();
        verify_honk_proof(verification_key, proof_right.unwrap(), right_inputs, vkey_hash);
        right_amount = right_inputs[0];
        right_leaf = right_inputs[1];
        // Ensure left and right have same vkey marker
        assert(right_inputs[2] == left_vkey_marker, "vkey marker mismatch between left and right proofs");
    } else {
        right_leaf = zero_leaf_hint.unwrap();
    }

    // 4. VKey validation based on marker
    if left_vkey_marker == 0 {
        // Level 0: verifying leaf proofs - check hardcoded leaf vkey hash
        assert(vkey_hash == LEAF_VKEY_HASH, "Invalid leaf vkey hash");
    } else {
        // Level 1+: verifying summary proofs
        // The marker should be the summary_vkey_hash from previous level
        assert(left_vkey_marker == vkey_hash, "vkey chain mismatch");
        // Also ensure consistency with the summary_vkey_hash we're outputting
        assert(vkey_hash == summary_vkey_hash, "vkey hash inconsistent with summary_vkey_hash");
    }

    // 5. Sum the values
    let sum = left_amount + right_amount;

    // 6. Hash the leaves into merkle root
    let root = Poseidon2::hash([left_leaf, right_leaf], 2);

    // 7. Output: (sum, root, summary_vkey_hash)
    // The summary_vkey_hash is passed through for chaining to higher levels
    (sum, root, summary_vkey_hash)
}
