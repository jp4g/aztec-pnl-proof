use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};
use dep::protocol_types::hash::poseidon2_hash;

/// Public inputs per child proof (6 Fields):
///   [0] leaf_or_root          - leaf hash (individual) or merkle root (summary)
///   [1] pnl                   - absolute PnL value
///   [2] pnl_is_negative       - 0 = gain/zero, 1 = loss
///   [3] remaining_lots_hash   - lot state after this proof
///   [4] initial_lots_hash     - lot state before this proof
///   [5] price_feed_address

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
) -> pub (Field, Field, Field, Field, Field, Field) {
    // 1. Verify left proof (always present)
    verify_honk_proof(verification_key, proof_left, public_inputs_left, vkey_hash);

    // 2. Extract values from left proof
    let left_node = public_inputs_left[0];
    let left_pnl = public_inputs_left[1];
    let left_pnl_neg = public_inputs_left[2];
    let left_remaining_lots = public_inputs_left[3];
    let left_initial_lots = public_inputs_left[4];
    let left_price_feed = public_inputs_left[5];

    // 3. Handle right proof (if present) or use zero padding
    let mut right_node: Field = 0;
    let mut right_pnl: Field = 0;
    let mut right_pnl_neg: Field = 0;
    let mut right_remaining_lots: Field = 0;
    let mut right_initial_lots: Field = 0;

    if proof_right.is_some() {
        let right_inputs = public_inputs_right.unwrap();
        verify_honk_proof(verification_key, proof_right.unwrap(), right_inputs, vkey_hash);

        right_node = right_inputs[0];
        right_pnl = right_inputs[1];
        right_pnl_neg = right_inputs[2];
        right_remaining_lots = right_inputs[3];
        right_initial_lots = right_inputs[4];

        // Ensure same price feed address
        assert(right_inputs[5] == left_price_feed, "price feed address mismatch");

        // 4. Verify lot hash chain: left's remaining must equal right's initial
        assert(
            left_remaining_lots == right_initial_lots,
            "lot hash chain broken: left remaining != right initial",
        );
    } else {
        right_node = zero_leaf_hint.unwrap();
        // right_pnl stays 0, right_pnl_neg stays 0
        // For padding: right's initial lots = left's remaining lots (trivial chain)
        right_remaining_lots = left_remaining_lots;
        right_initial_lots = left_remaining_lots;
    }

    // 5. VKey validation based on level
    // Individual swap proofs don't output a vkey marker. Instead we use a convention:
    // At level 0 (verifying leaf proofs), we check against leaf_vkey_hash.
    // At level 1+ (verifying summary proofs), we check against summary_vkey_hash.
    // The caller passes the appropriate vkey_hash for the level being verified.
    // We need a way to detect the level. Use: if vkey_hash == leaf_vkey_hash, it's level 0.
    if vkey_hash == leaf_vkey_hash {
        // Level 0: verifying individual swap proofs
        // No additional vkey chain check needed
    } else {
        // Level 1+: verifying summary proofs - vkey must match summary_vkey_hash
        assert(vkey_hash == summary_vkey_hash, "vkey hash inconsistent with summary_vkey_hash");
    }

    // 6. Hash the nodes into merkle root
    let root = poseidon2_hash([left_node, right_node]);

    // 7. Sum signed PnL using i64
    let left_pnl_signed: i64 = if left_pnl_neg == 1 {
        -(left_pnl as i64)
    } else {
        left_pnl as i64
    };
    let right_pnl_signed: i64 = if right_pnl_neg == 1 {
        -(right_pnl as i64)
    } else {
        right_pnl as i64
    };
    let total_pnl_signed: i64 = left_pnl_signed + right_pnl_signed;

    let total_pnl_is_negative: Field = if total_pnl_signed < 0 { 1 } else { 0 };
    let total_pnl: Field = if total_pnl_signed < 0 {
        (-total_pnl_signed) as u64 as Field
    } else {
        total_pnl_signed as u64 as Field
    };

    // 8. Output: chain endpoints are left's initial and right's remaining
    (root, total_pnl, total_pnl_is_negative, right_remaining_lots, left_initial_lots, left_price_feed)
}
