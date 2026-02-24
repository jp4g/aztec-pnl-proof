use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};

fn main(
    verification_key: UltraHonkVerificationKey,
    vkey_hash: Field,
    proof: UltraHonkZKProof,
    public_inputs: [Field; 6],
) -> pub Field {
    verify_honk_proof(verification_key, proof, public_inputs, vkey_hash);
    public_inputs[0]
}
