use dep::aztec::{
    messages::encryption::aes128::derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe,
    keys::ecdh_shared_secret::derive_ecdh_shared_secret,
    utils::point::{point_from_x_coord_and_sign, get_sign_of_point},
};
use dep::std::{aes128::aes128_encrypt, embedded_curve_ops::EmbeddedCurveScalar};
use dep::protocol_types::{
    constants::GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
    merkle_tree::root::root_from_sibling_path,
    utils::field::full_field_less_than,
};

// ============================================================
// Public Data Tree
// ============================================================

pub global PUBLIC_DATA_TREE_HEIGHT: u32 = 40;

pub struct PublicDataLeafPreimage {
    pub slot: Field,
    pub value: Field,
    pub next_slot: Field,
    pub next_index: Field,
}

impl PublicDataLeafPreimage {
    pub fn hash(self) -> Field {
        let is_empty = (self.slot == 0) & (self.value == 0) & (self.next_slot == 0) & (self.next_index == 0);
        if is_empty {
            0
        } else {
            poseidon2_hash([self.slot, self.value, self.next_index, self.next_slot])
        }
    }
}

pub struct PriceWitness {
    pub leaf_preimage: PublicDataLeafPreimage,
    pub witness_index: Field,
    pub witness_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
}

pub fn compute_public_data_tree_index(contract_address: Field, storage_slot: Field) -> Field {
    poseidon2_hash_with_separator(
        [contract_address, storage_slot],
        GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
    )
}

pub fn derive_storage_slot_in_map(storage_slot: Field, key: Field) -> Field {
    poseidon2_hash([storage_slot, key])
}

pub fn verify_and_read_public_data(
    public_data_tree_root: Field,
    tree_index: Field,
    witness: PriceWitness,
) -> Field {
    let leaf_hash = witness.leaf_preimage.hash();
    let computed_root = root_from_sibling_path(leaf_hash, witness.witness_index, witness.witness_path);
    assert_eq(computed_root, public_data_tree_root, "Merkle membership proof failed");

    let is_less_than_slot = full_field_less_than(witness.leaf_preimage.slot, tree_index);
    let is_next_greater_than = full_field_less_than(tree_index, witness.leaf_preimage.next_slot);
    let is_max = (witness.leaf_preimage.next_index == 0) & (witness.leaf_preimage.next_slot == 0);
    let is_in_range = is_less_than_slot & (is_next_greater_than | is_max);

    if is_in_range {
        0
    } else {
        assert_eq(witness.leaf_preimage.slot, tree_index, "Public data tree index doesn't match witness");
        witness.leaf_preimage.value
    }
}

// ============================================================
// Byte Helpers
// ============================================================

pub global SWAP_PLAINTEXT_FIELDS: u32 = 7;
pub global PLAINTEXT_BYTES_LEN: u32 = 224; // 7 fields * 32 bytes
pub global CIPHERTEXT_BYTES_LEN: u32 = 496; // 16 ciphertext fields * 31 bytes each
global HEADER_CIPHERTEXT_SIZE_IN_BYTES: u32 = 16;

/// Reconstruct a Field from 32 big-endian bytes.
fn bytes_to_field(bytes: [u8; 32]) -> Field {
    let mut result: Field = 0;
    for i in 0..32 {
        result = result * 256 + bytes[i] as Field;
    }
    result
}

/// Extract the i-th plaintext field (32 bytes big-endian) from the byte array.
pub fn extract_plaintext_field(plaintext_bytes: [u8; PLAINTEXT_BYTES_LEN], index: u32) -> Field {
    let mut field_bytes = [0 as u8; 32];
    let offset = index * 32;
    for j in 0..32 {
        field_bytes[j] = plaintext_bytes[offset + j];
    }
    bytes_to_field(field_bytes)
}

// ============================================================
// Encryption Verification
// ============================================================

/// Verify that the plaintext bytes encrypt to the given ciphertext bytes.
///
/// Takes raw bytes directly as circuit inputs, avoiding expensive in-circuit
/// field-to-byte serialization (~400 gates/field via to_be_bytes range checks).
/// Byte-to-field reconstruction for swap values costs only ~32 gates/field.
pub fn verify_encryption(
    plaintext_bytes: [u8; PLAINTEXT_BYTES_LEN],
    eph_pk_x: Field,
    ciphertext_bytes: [u8; CIPHERTEXT_BYTES_LEN],
    ivsk_app: Field,
) {
    // First byte is the ephemeral public key sign
    let eph_pk_sign_byte = ciphertext_bytes[0];
    let eph_pk_sign = eph_pk_sign_byte != 0;

    // Reconstruct ephemeral public key and derive shared secret
    let eph_pk = point_from_x_coord_and_sign(eph_pk_x, eph_pk_sign)
        .expect(f"Invalid ephemeral public key x-coordinate");
    let recipient_sk_scalar = EmbeddedCurveScalar::from_field(ivsk_app);
    let shared_secret = derive_ecdh_shared_secret(recipient_sk_scalar, eph_pk);

    // Derive AES body key
    let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(shared_secret);
    let (body_sym_key, body_iv) = pairs[0];

    // Encrypt plaintext and compare body ciphertext.
    // Header ciphertext (bytes 1..17) is skipped -- body length is known at compile time
    // (7 * 32 = 224 bytes) and the body check proves correct shared secret.
    let computed_body = aes128_encrypt(plaintext_bytes, body_iv, body_sym_key);
    let body_start = 1 + HEADER_CIPHERTEXT_SIZE_IN_BYTES;
    for i in 0..computed_body.len() {
        if body_start + i < ciphertext_bytes.len() {
            assert(
                computed_body[i] == ciphertext_bytes[body_start + i],
                "Body ciphertext mismatch",
            );
        }
    }

    // Verify ephemeral public key sign byte matches
    assert(eph_pk_sign_byte == get_sign_of_point(eph_pk) as u8, "Ephemeral PK sign mismatch");
}
