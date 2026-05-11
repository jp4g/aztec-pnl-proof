import { Aes128 } from '@aztec/foundation/crypto/aes128';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { Point } from '@aztec/foundation/curves/grumpkin';
import { DomainSeparator } from '@aztec/constants';
import { deriveAppSiloedSharedSecret } from '@aztec/stdlib/logs';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import { MESSAGE_CIPHERTEXT_LEN, TAG_SIZE } from './constants';
import { error as logError } from './logger';

const HEADER_CIPHERTEXT_SIZE_IN_BYTES = 16;
const TWO_POW_248 = 1n << 248n;

export interface DecryptedLog {
    plaintext: Fr[];
    sApp: Fr;
}

/**
 * Decrypt an Aztec 4.2 encrypted log and return the private app-siloed secret used by the circuit.
 */
export async function decryptLog(
    encryptedLog: Buffer,
    recipientCompleteAddress: CompleteAddress,
    ivskM: any, // GrumpkinScalar type
    app: string,
): Promise<DecryptedLog | null> {
    try {
        const ciphertextFields = parseCiphertextFields(encryptedLog);
        const ephPk = await reconstructPublicKey(ciphertextFields[0], true);
        if (!ephPk) {
            logError('Failed to reconstruct ephemeral public key');
            return null;
        }

        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);
        const sApp = await deriveAppSiloedSharedSecret(
            addressSecret,
            ephPk,
            AztecAddress.fromString(app),
        );

        const maskedFields = ciphertextFields.slice(1);
        const unmaskedFields = await unmaskCiphertextFields(maskedFields, sApp);
        const messageBytes = fieldsToBytes(unmaskedFields);

        const { bodyKey, bodyIv, headerKey, headerIv } = await deriveAesKeys(sApp);
        const aes = new Aes128();
        const headerCiphertext = messageBytes.slice(0, HEADER_CIPHERTEXT_SIZE_IN_BYTES);
        const headerPlaintext = await aes.decryptBufferCBC(
            headerCiphertext,
            headerIv,
            headerKey
        );
        const ciphertextLength = (headerPlaintext[0] << 8) | headerPlaintext[1];

        const bodyStart = HEADER_CIPHERTEXT_SIZE_IN_BYTES;
        const bodyCiphertext = messageBytes.slice(bodyStart, bodyStart + ciphertextLength);
        if (bodyCiphertext.length !== ciphertextLength) {
            throw new Error(`Ciphertext body length ${bodyCiphertext.length} does not match header ${ciphertextLength}`);
        }

        const bodyPlaintext = await aes.decryptBufferCBC(
            bodyCiphertext,
            bodyIv,
            bodyKey
        );

        const fields: Fr[] = [];
        for (let i = 0; i < bodyPlaintext.length; i += 32) {
            if (i + 32 <= bodyPlaintext.length) {
                const fieldBytes = bodyPlaintext.slice(i, i + 32);
                fields.push(Fr.fromBuffer(fieldBytes));
            }
        }

        return { plaintext: fields, sApp };
    } catch (error) {
        logError('Decryption failed:', error);
        return null;
    }
}

async function deriveAesKeys(sApp: Fr): Promise<{
    bodyKey: Buffer;
    bodyIv: Buffer;
    headerKey: Buffer;
    headerIv: Buffer;
}> {
    const subkeys = await Promise.all([0, 1, 2, 3].map(i =>
        poseidon2HashWithSeparator([sApp], DomainSeparator.ECDH_SUBKEY + i)
    ));
    const extract = (rand: Fr) => Buffer.from(rand.toBuffer().slice(16, 32)).reverse();

    return {
        bodyKey: extract(subkeys[0]),
        bodyIv: extract(subkeys[1]),
        headerKey: extract(subkeys[2]),
        headerIv: extract(subkeys[3]),
    };
}

function parseCiphertextFields(encryptedLog: Buffer): Fr[] {
    const ciphertextWithoutTag = encryptedLog.slice(TAG_SIZE);
    const padded = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
    ciphertextWithoutTag.copy(padded, 0, 0, Math.min(ciphertextWithoutTag.length, padded.length));

    const fields: Fr[] = [];
    for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
        fields.push(Fr.fromBuffer(padded.slice(i * 32, (i + 1) * 32)));
    }
    return fields;
}

async function unmaskCiphertextFields(maskedFields: Fr[], sApp: Fr): Promise<Fr[]> {
    return await Promise.all(maskedFields.map(async (field, index) => {
        const mask = await poseidon2HashWithSeparator([sApp], DomainSeparator.ECDH_FIELD_MASK + index);
        const unmasked = field.sub(mask);
        return unmasked.toBigInt() < TWO_POW_248 ? unmasked : Fr.ZERO;
    }));
}

function fieldsToBytes(fields: Fr[]): Buffer {
    return Buffer.concat(fields.map(field => field.toBuffer().slice(1, 32)));
}

async function reconstructPublicKey(x: Fr, signBit: boolean): Promise<Point | null> {
    try {
        const point = await Point.fromXAndSign(x, signBit);
        return point;
    } catch (error) {
        logError('Failed to reconstruct point from x-coordinate:', error);
        return null;
    }
}
