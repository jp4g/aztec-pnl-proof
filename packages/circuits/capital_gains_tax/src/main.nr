use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};

/// Wraps a summary tree proof and computes capital gains tax at a flat 20% rate.
///
/// Public inputs from the summary proof (6 Fields):
///   [0] root                     - merkle root of swap ciphertext leaves
///   [1] pnl                      - signed PnL (i64 encoded as Field)
///   [2] remaining_lot_state_root - lot state after all swaps
///   [3] initial_lot_state_root   - lot state before all swaps
///   [4] price_feed_address
///   [5] block_number
///
/// Returns 7 public outputs: all 6 forwarded + tax inserted at index 2.
fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof: UltraHonkZKProof,
    public_inputs: [Field; 6],
    summary_vkey_hash: Field,
) -> pub (Field, i64, i64, Field, Field, Field, Field) {
    // 1. Verify the summary tree proof
    verify_honk_proof(verification_key, proof, public_inputs, vkey_hash);
    assert(vkey_hash == summary_vkey_hash, "vkey hash must match summary circuit");

    // 2. Decode PnL from two's complement Field encoding
    let pnl: i64 = public_inputs[1] as i64;

    // 3. Compute tax: 20% of gains, 0 on losses
    let tax: i64 = if pnl > 0 { pnl / 5 } else { 0 };

    // 4. Forward summary outputs + tax
    (
        public_inputs[0],  // root
        pnl,               // pnl
        tax,               // tax (NEW)
        public_inputs[2],  // remaining_lot_state_root
        public_inputs[3],  // initial_lot_state_root
        public_inputs[4],  // price_feed_address
        public_inputs[5],  // block_number
    )
}
