use aztec::{
    messages::{
        encoding::{MESSAGE_CIPHERTEXT_LEN, EPH_PK_X_SIZE_IN_FIELDS},
        encryption::aes128::derive_aes_symmetric_key_and_iv_from_shared_secret,
    },
    keys::ecdh_shared_secret::derive_ecdh_shared_secret,
    utils::point::point_from_x_coord_and_sign,
};
use std::{aes128::aes128_encrypt, embedded_curve_ops::EmbeddedCurveScalar};
use protocol_types::{
    constants::{
        DOM_SEP__APP_SILOED_ECDH_SHARED_SECRET,
        DOM_SEP__ECDH_FIELD_MASK,
        DOM_SEP__PUBLIC_LEAF_SLOT,
        DOM_SEP__PUBLIC_STORAGE_MAP_SLOT,
    },
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
    merkle_tree::root::root_from_sibling_path,
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
            poseidon2_hash([self.slot, self.value, self.next_slot, self.next_index])
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
        DOM_SEP__PUBLIC_LEAF_SLOT,
    )
}

pub fn derive_storage_slot_in_map(storage_slot: Field, key: Field) -> Field {
    poseidon2_hash_with_separator([storage_slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)
}

pub fn verify_and_read_public_data(
    public_data_tree_root: Field,
    tree_index: Field,
    witness: PriceWitness,
) -> Field {
    let leaf_hash = witness.leaf_preimage.hash();
    let computed_root = root_from_sibling_path(leaf_hash, witness.witness_index, witness.witness_path);
    assert_eq(computed_root, public_data_tree_root, "Merkle membership proof failed");

    let is_less_than_slot = witness.leaf_preimage.slot.lt(tree_index);
    let is_next_greater_than = tree_index.lt(witness.leaf_preimage.next_slot);
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
// Ciphertext Field Handling
// ============================================================

pub global SWAP_PLAINTEXT_FIELDS: u32 = 7;
pub global PLAINTEXT_BYTES_LEN: u32 = 224; // 7 fields * 32 bytes
global HEADER_CIPHERTEXT_SIZE_IN_BYTES: u32 = 16;
global AES128_PKCS7_EXPANSION_IN_BYTES: u32 = 16;
global MESSAGE_BYTES_LEN: u32 = HEADER_CIPHERTEXT_SIZE_IN_BYTES + PLAINTEXT_BYTES_LEN + AES128_PKCS7_EXPANSION_IN_BYTES;
global MESSAGE_FIELDS_LEN: u32 = (MESSAGE_BYTES_LEN + 30) / 31;
global MESSAGE_PADDED_BYTES_LEN: u32 = MESSAGE_FIELDS_LEN * 31;
global TWO_POW_248: Field = 2.pow_32(248);

/// Convert ciphertext fields (excluding eph_pk_x) to bytes.
/// Each field stores 31 bytes (high byte is always 0).
fn bytes_from_fields(fields: [Field; MESSAGE_FIELDS_LEN]) -> [u8; MESSAGE_PADDED_BYTES_LEN] {
    let mut bytes = [0 as u8; MESSAGE_PADDED_BYTES_LEN];
    for i in 0..MESSAGE_FIELDS_LEN {
        let field_bytes: [u8; 32] = fields[i].to_be_bytes();
        for j in 0..31 {
            bytes[i * 31 + j] = field_bytes[j + 1];
        }
    }
    bytes
}

/// Extract ciphertext fields without the ephemeral PK x-coordinate.
fn extract_ciphertext_fields(
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
) -> [Field; MESSAGE_CIPHERTEXT_LEN - 1] {
    let mut result = [0 as Field; MESSAGE_CIPHERTEXT_LEN - 1];
    for i in 0..MESSAGE_CIPHERTEXT_LEN - 1 {
        result[i] = ciphertext[EPH_PK_X_SIZE_IN_FIELDS + i];
    }
    result
}

fn compute_app_siloed_shared_secret(shared_secret_x: Field, shared_secret_y: Field, contract_address: Field) -> Field {
    poseidon2_hash_with_separator(
        [shared_secret_x, shared_secret_y, contract_address],
        DOM_SEP__APP_SILOED_ECDH_SHARED_SECRET,
    )
}

fn unmask_ciphertext_fields(
    masked_fields: [Field; MESSAGE_CIPHERTEXT_LEN - 1],
    s_app: Field,
) -> [Field; MESSAGE_FIELDS_LEN] {
    let mut result = [0 as Field; MESSAGE_FIELDS_LEN];
    for i in 0..MESSAGE_FIELDS_LEN {
        let mask = poseidon2_hash_with_separator([s_app], DOM_SEP__ECDH_FIELD_MASK + i);
        let unmasked = masked_fields[i] - mask;
        assert(unmasked.lt(TWO_POW_248), "Ciphertext field is not valid packed bytes");
        result[i] = unmasked;
    }
    result
}

/// Convert plaintext fields to bytes (32 bytes per field, big-endian).
fn plaintext_fields_to_bytes(plaintext: [Field; SWAP_PLAINTEXT_FIELDS]) -> [u8; PLAINTEXT_BYTES_LEN] {
    let mut bytes = [0 as u8; PLAINTEXT_BYTES_LEN];
    for i in 0..SWAP_PLAINTEXT_FIELDS {
        let field_bytes: [u8; 32] = plaintext[i].to_be_bytes();
        for j in 0..32 {
            bytes[i * 32 + j] = field_bytes[j];
        }
    }
    bytes
}

// ============================================================
// Encryption Verification
// ============================================================

pub fn verify_encryption(
    plaintext: [Field; SWAP_PLAINTEXT_FIELDS],
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
    ivsk_app: Field,
    contract_address: Field,
) {
    let eph_pk_x = ciphertext[0];
    let masked_fields = extract_ciphertext_fields(ciphertext);

    // Aztec encrypted logs use positive-y ephemeral keys here (no sign byte).
    let eph_pk = point_from_x_coord_and_sign(eph_pk_x, true)
        .expect(f"Invalid ephemeral public key x-coordinate");
    let recipient_sk_scalar = EmbeddedCurveScalar::from_field(ivsk_app);
    let shared_secret = derive_ecdh_shared_secret(recipient_sk_scalar, eph_pk);
    let s_app = compute_app_siloed_shared_secret(shared_secret.x, shared_secret.y, contract_address);
    let ciphertext_fields = unmask_ciphertext_fields(masked_fields, s_app);
    let ciphertext_bytes = bytes_from_fields(ciphertext_fields);

    let pairs = derive_aes_symmetric_key_and_iv_from_shared_secret::<2>(s_app);
    let (body_sym_key, body_iv) = pairs[0];

    let plaintext_bytes = plaintext_fields_to_bytes(plaintext);
    let computed_body = aes128_encrypt(plaintext_bytes, body_iv, body_sym_key);
    let body_start = HEADER_CIPHERTEXT_SIZE_IN_BYTES;
    for i in 0..computed_body.len() {
        if body_start + i < ciphertext_bytes.len() {
            assert(
                computed_body[i] == ciphertext_bytes[body_start + i],
                "Body ciphertext mismatch",
            );
        }
    }

}

// ============================================================
// FIFO Lot Tracking
// ============================================================

pub global MAX_LOTS: u32 = 32;
pub global LOTS_HASH_PREIMAGE_LEN: u32 = 66; // MAX_LOTS * 2 + 2 (token_address + num_lots)
pub global LOT_TREE_HEIGHT: u32 = 3; // 8 token slots

pub struct Lot {
    pub amount: Field,
    pub cost_per_unit: Field,
}

pub fn hash_lots(token_address: Field, lots: [Lot; MAX_LOTS], num_lots: u32) -> Field {
    if num_lots == 0 {
        0
    } else {
        let mut preimage: [Field; LOTS_HASH_PREIMAGE_LEN] = [0; LOTS_HASH_PREIMAGE_LEN];
        preimage[0] = token_address;
        preimage[1] = num_lots as Field;
        for i in 0..MAX_LOTS {
            preimage[2 + i * 2] = lots[i].amount;
            preimage[2 + i * 2 + 1] = lots[i].cost_per_unit;
        }
        poseidon2_hash(preimage)
    }
}
