use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof_a: UltraHonkZKProof,
    public_inputs_a: [Field; 6],
    proof_b: UltraHonkZKProof,
    public_inputs_b: [Field; 6],
) -> pub Field {
    verify_honk_proof(verification_key, proof_a, public_inputs_a, vkey_hash);
    verify_honk_proof(verification_key, proof_b, public_inputs_b, vkey_hash);
    public_inputs_a[0]
}
