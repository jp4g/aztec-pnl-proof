import { Aes128 } from '@aztec/foundation/crypto/aes128';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { Point } from '@aztec/foundation/curves/grumpkin';
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { DomainSeparator } from '@aztec/constants';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import { TAG_SIZE } from './constants';
import { error as logError } from './logger';

type ContractAddressLike = Fr | string | { toField: () => Fr };
const TWO_POW_248 = 1n << 248n;

/**
 * Decrypt an encrypted log (note or event).
 *
 * Based on the flow from note-encryption-decryption-walkthrough.md.
 * Works for both notes and events since they use the same AES128 encryption scheme.
 *
 * @param encryptedLog - The encrypted log buffer (hex string from ciphertext)
 * @param recipientCompleteAddress - The recipient's complete address (includes keys and preaddress)
 * @param ivskM - The recipient's master incoming viewing secret key
 * @param contractAddress - The contract that emitted the encrypted event
 * @returns The decrypted plaintext fields, or null if decryption fails
 */
export async function decryptLog(
    encryptedLog: Buffer,
    recipientCompleteAddress: CompleteAddress,
    ivskM: any, // GrumpkinScalar type
    contractAddress: ContractAddressLike,
): Promise<Fr[] | null> {
    try {
        // Step 1: Parse ciphertext structure
        // Format: [tag (32 bytes) | eph_pk.x (32 bytes) | masked fields (31 bytes each)]
        // Skip the tag (first 32 bytes)
        const ciphertextWithoutTag = encryptedLog.slice(TAG_SIZE);
        const ephPkX = Fr.fromBuffer(ciphertextWithoutTag.slice(0, 32));

        // Aztec SDK encrypted logs use positive-y ephemeral keys here.
        // (generated via generate_positive_ephemeral_key_pair), so sign is always true.
        const ephPk = await reconstructPublicKey(ephPkX, true);
        if (!ephPk) {
            logError('Failed to reconstruct ephemeral public key');
            return null;
        }

        // Step 2: Compute address secret
        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);

        // Step 3: Derive shared secret (ECDH)
        const sharedSecret = await deriveEcdhSharedSecret(addressSecret, ephPk);
        const appSecret = await computeAppSiloedSharedSecret(
            sharedSecret,
            contractAddressToField(contractAddress),
        );

        // Step 4: Unmask and unpack the ciphertext fields
        const maskedFieldsBuffer = ciphertextWithoutTag.slice(32);
        const restBytes = await unpackMaskedFieldsToBytes(maskedFieldsBuffer, appSecret);

        // Step 5: Derive AES symmetric keys from app-siloed shared secret
        const { bodyKey, bodyIv, headerKey, headerIv } = await deriveAesKeys(appSecret);

        // Step 6: Extract and decrypt header
        // No sign byte is encoded — header starts at byte 0.
        const headerCiphertext = restBytes.slice(0, 16);
        const aes = new Aes128();
        const headerPlaintext = await aes.decryptBufferCBC(
            headerCiphertext,
            headerIv,
            headerKey
        );

        // Extract ciphertext length from header (2 bytes, big-endian)
        const ciphertextLength = (headerPlaintext[0] << 8) | headerPlaintext[1];

        // Step 7: Decrypt body
        const bodyStart = 16; // header is 16 bytes, no sign byte
        const availableBytes = restBytes.length - bodyStart;
        const actualLength = Math.min(ciphertextLength, availableBytes);
        const bodyCiphertext = restBytes.slice(bodyStart, bodyStart + actualLength);
        const bodyPlaintext = await aes.decryptBufferCBC(
            bodyCiphertext,
            bodyIv,
            bodyKey
        );

        // Step 8: Convert bytes back to fields (32 bytes per field)
        const fields: Fr[] = [];
        for (let i = 0; i < bodyPlaintext.length; i += 32) {
            if (i + 32 <= bodyPlaintext.length) {
                const fieldBytes = bodyPlaintext.slice(i, i + 32);
                fields.push(Fr.fromBuffer(fieldBytes));
            }
        }

        return fields;
    } catch (error) {
        logError('Decryption failed:', error);
        return null;
    }
}

function contractAddressToField(contractAddress: ContractAddressLike): Fr {
    if (typeof contractAddress === 'string') {
        return Fr.fromString(contractAddress);
    }
    if ('toField' in contractAddress) {
        return contractAddress.toField();
    }
    return contractAddress;
}

/**
 * Derive the raw ECDH shared secret point S = secretKey * publicKey on Grumpkin.
 *
 * Note: the underlying operation is scalar multiplication on the Grumpkin curve.
 */
async function deriveEcdhSharedSecret(secretKey: any, publicKey: Point): Promise<Point> {
    if ((publicKey as any).isZero?.()) {
        throw new Error('Attempting to derive a shared secret with a zero public key.');
    }
    return await Grumpkin.mul(publicKey, secretKey);
}

async function computeAppSiloedSharedSecret(sharedSecret: Point, contractAddress: Fr): Promise<Fr> {
    return await poseidon2HashWithSeparator(
        [sharedSecret.x, sharedSecret.y, contractAddress],
        DomainSeparator.APP_SILOED_ECDH_SHARED_SECRET,
    );
}

/**
 * Derive AES keys and IVs from app-siloed ECDH shared secret using Poseidon2.
 *
 * This follows the pattern from aes128.nr in the Aztec codebase.
 */
async function deriveAesKeys(appSecret: Fr): Promise<{
    bodyKey: Buffer;
    bodyIv: Buffer;
    headerKey: Buffer;
    headerIv: Buffer;
}> {
    const [rand1, rand2, rand3, rand4] = await Promise.all([
        deriveSharedSecretSubkey(appSecret, 0),
        deriveSharedSecretSubkey(appSecret, 1),
        deriveSharedSecretSubkey(appSecret, 2),
        deriveSharedSecretSubkey(appSecret, 3),
    ]);

    // Extract 16 bytes from the "little end" of each (last 16 bytes) and reverse.
    // Noir code extracts bytes in reverse order: bytes[i] = rand_bytes[31-i]
    const extractKey = (rand: Fr) => Buffer.from(rand.toBuffer().slice(16, 32)).reverse();

    return {
        bodyKey: extractKey(rand1),
        bodyIv: extractKey(rand2),
        headerKey: extractKey(rand3),
        headerIv: extractKey(rand4),
    };
}

async function deriveSharedSecretSubkey(appSecret: Fr, index: number): Promise<Fr> {
    return await poseidon2HashWithSeparator(
        [appSecret],
        DomainSeparator.ECDH_SUBKEY + index,
    );
}

/**
 * Unmask fields and unpack those that were packed with 31 bytes per field back into bytes.
 */
async function unpackMaskedFieldsToBytes(packedBuffer: Buffer, appSecret: Fr): Promise<Buffer> {
    const numFields = Math.floor(packedBuffer.length / 32);
    const unpacked: Buffer[] = [];

    for (let i = 0; i < numFields; i++) {
        const fieldBuffer = packedBuffer.slice(i * 32, (i + 1) * 32);
        const maskedField = Fr.fromBuffer(fieldBuffer);
        const mask = await poseidon2HashWithSeparator(
            [appSecret],
            DomainSeparator.ECDH_FIELD_MASK + i,
        );
        const unmaskedField = maskedField.sub(mask);
        if (unmaskedField.toBigInt() >= TWO_POW_248) {
            break;
        }

        // Each field stores 31 bytes (the high byte is always 0 in valid field packing).
        // Take the last 31 bytes of the 32-byte field representation.
        const bytes31 = unmaskedField.toBuffer().slice(1, 32);
        unpacked.push(bytes31);
    }

    return Buffer.concat(unpacked);
}

/**
 * Reconstruct a Grumpkin point from its x-coordinate and sign bit.
 */
async function reconstructPublicKey(x: Fr, signBit: boolean): Promise<Point | null> {
    try {
        // Use Point.fromXAndSign to lift x to a point
        // The sign bit tells us which of the two possible y-coordinates to use
        const point = await Point.fromXAndSign(x, signBit);
        return point;
    } catch (error) {
        logError('Failed to reconstruct point from x-coordinate:', error);
        return null;
    }
}
