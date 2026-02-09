use dep::aztec::{
    messages::{
        encoding::{MESSAGE_CIPHERTEXT_LEN, EPH_PK_X_SIZE_IN_FIELDS},
        encryption::aes128::derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe,
    },
    keys::ecdh_shared_secret::derive_ecdh_shared_secret,
    utils::point::{point_from_x_coord_and_sign, get_sign_of_point},
};
pub global HEADER_CIPHERTEXT_SIZE_IN_BYTES: u32 = 16;
use dep::std::{aes128::aes128_encrypt, embedded_curve_ops::EmbeddedCurveScalar};
use dep::protocol_types::hash::poseidon2_hash;

/// Number of plaintext fields for a Swap event:
///   1 (expanded_metadata) + 1 (randomness) + 5 (token_in, token_out, amount_in, amount_out, is_exact_input)
global SWAP_PLAINTEXT_FIELDS: u32 = 7;

fn main(
    plaintext: BoundedVec<Field, 14>,
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
    ivsk_app: Field,
    block_number: Field,
) -> pub (Field, Field) {
    // 1. Constrain the plaintext to encrypt to the asserted ciphertext
    verify_encryption(plaintext, ciphertext, ivsk_app);

    // 2. Extract swap event values from the plaintext
    let (token_in, token_out, amount_in, amount_out, is_exact_input) = get_swap_values(plaintext);

    // 3. Compute leaf hash binding swap data to the block number
    // This hash will be used as a leaf in the aggregation merkle tree
    let leaf = poseidon2_hash(
        [block_number, token_in, token_out, amount_in, amount_out, is_exact_input],
    );

    // Return (leaf_hash, 0) - the sentinel 0 marks this as a leaf-level proof
    (leaf, 0)
}

/// Verify that the plaintext encrypts to the given ciphertext
fn verify_encryption(
    plaintext: BoundedVec<Field, 14>,
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
    ivsk_app: Field,
) {
    // Extract ephemeral public key x-coordinate from ciphertext
    let eph_pk_x = ciphertext[0];

    // Extract the encrypted bytes (convert fields back to bytes)
    let ciphertext_without_eph_pk_x = extract_ciphertext_fields(ciphertext);
    let ciphertext_bytes = bytes_from_fields(ciphertext_without_eph_pk_x);

    // First byte contains the ephemeral public key sign
    let eph_pk_sign_byte = ciphertext_bytes[0];
    let eph_pk_sign = eph_pk_sign_byte != 0;

    // Reconstruct ephemeral public key
    let eph_pk = point_from_x_coord_and_sign(eph_pk_x, eph_pk_sign).expect(f"Invalid ephemeral public key x-coordinate");

    // Derive shared secret using recipient's secret key and ephemeral public key
    let recipient_sk_scalar = EmbeddedCurveScalar::from_field(ivsk_app);
    let shared_secret = derive_ecdh_shared_secret(recipient_sk_scalar, eph_pk);

    // Derive AES keys from shared secret
    let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(shared_secret);
    let (body_sym_key, body_iv) = pairs[0];
    let (header_sym_key, header_iv) = pairs[1];

    // Swap event has exactly SWAP_PLAINTEXT_FIELDS fields in the plaintext:
    // [expanded_metadata, randomness, token_in, token_out, amount_in, amount_out, is_exact_input]
    // Each field is 32 bytes, so SWAP_PLAINTEXT_FIELDS * 32 bytes
    assert(plaintext.len() == SWAP_PLAINTEXT_FIELDS, "Expected 7 fields for Swap event plaintext");

    // Convert fields to bytes
    let mut plaintext_bytes: [u8; SWAP_PLAINTEXT_FIELDS * 32] = [0; SWAP_PLAINTEXT_FIELDS * 32];
    for i in 0..SWAP_PLAINTEXT_FIELDS {
        let field = plaintext.get(i);
        let field_bytes: [u8; 32] = field.to_be_bytes();
        for j in 0..32 {
            plaintext_bytes[i * 32 + j] = field_bytes[j];
        }
    }

    // Encrypt the plaintext body
    let computed_body_ciphertext = aes128_encrypt(plaintext_bytes, body_iv, body_sym_key);

    // Compute header ciphertext (contains length)
    let mut header_plaintext = [0 as u8; 2];
    let ciphertext_length = computed_body_ciphertext.len();
    header_plaintext[0] = (ciphertext_length / 256) as u8;
    header_plaintext[1] = ciphertext_length as u8;
    let computed_header_ciphertext = aes128_encrypt(header_plaintext, header_iv, header_sym_key);

    // Extract actual header and body from provided ciphertext
    let header_start = 1; // After sign byte
    let header_end = header_start + HEADER_CIPHERTEXT_SIZE_IN_BYTES;
    let body_start = header_end;

    // Compare header ciphertext
    for i in 0..HEADER_CIPHERTEXT_SIZE_IN_BYTES {
        assert(
            computed_header_ciphertext[i] == ciphertext_bytes[header_start + i],
            "Header ciphertext mismatch",
        );
    }

    // Compare body ciphertext (up to actual length)
    for i in 0..computed_body_ciphertext.len() {
        if body_start + i < ciphertext_bytes.len() {
            assert(
                computed_body_ciphertext[i] == ciphertext_bytes[body_start + i],
                "Body ciphertext mismatch",
            );
        }
    }

    // Verify ephemeral public key sign byte matches
    assert(eph_pk_sign_byte == get_sign_of_point(eph_pk) as u8, "Ephemeral PK sign mismatch");
}

/// Extract ciphertext fields (excluding ephemeral PK x-coordinate)
fn extract_ciphertext_fields(
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
) -> BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN - 1> {
    let mut result = BoundedVec::new();
    for i in EPH_PK_X_SIZE_IN_FIELDS..MESSAGE_CIPHERTEXT_LEN {
        result.push(ciphertext[i]);
    }
    result
}

/// Convert fields to bytes (reverse of bytes_to_fields)
fn bytes_from_fields(
    fields: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN - 1>,
) -> [u8; (MESSAGE_CIPHERTEXT_LEN - 1) * 31] {
    let mut bytes = [0 as u8; (MESSAGE_CIPHERTEXT_LEN - 1) * 31];
    for i in 0..fields.len() {
        let field = fields.get(i);
        let field_bytes: [u8; 32] = field.to_be_bytes();
        // Each field stores 31 bytes (skip the high byte which is always 0)
        for j in 0..31 {
            bytes[i * 31 + j] = field_bytes[j + 1];
        }
    }
    bytes
}

/// Extract swap event values from the decrypted plaintext.
///
/// Plaintext layout:
///   [0] expanded_metadata = (PRIVATE_EVENT_MSG_TYPE_ID << 64) | event_type_id
///   [1] randomness
///   [2] token_in (AztecAddress as Field)
///   [3] token_out (AztecAddress as Field)
///   [4] amount_in (u128 as Field)
///   [5] amount_out (u128 as Field)
///   [6] is_exact_input (bool as Field)
fn get_swap_values(plaintext: BoundedVec<Field, 14>) -> (Field, Field, Field, Field, Field) {
    let token_in = plaintext.get(2);
    let token_out = plaintext.get(3);
    let amount_in = plaintext.get(4);
    let amount_out = plaintext.get(5);
    let is_exact_input = plaintext.get(6);
    (token_in, token_out, amount_in, amount_out, is_exact_input)
}
