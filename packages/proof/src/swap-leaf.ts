import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { MESSAGE_CIPHERTEXT_LEN, TAG_SIZE } from './constants';

export type FieldLike = Fr | bigint | number | string;

function toFr(value: FieldLike, name: string): Fr {
    if (value instanceof Fr) return value;
    if (typeof value === 'bigint' || typeof value === 'number') return new Fr(value);
    if (typeof value === 'string') return Fr.fromString(value);
    throw new Error(`${name} must be an Fr, bigint, number, or string`);
}

export function parseSwapCiphertextFields(encryptedLog: Buffer): Fr[] {
    const ciphertextWithoutTag = encryptedLog.slice(TAG_SIZE);
    const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
    ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

    const fields: Fr[] = [];
    for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
        fields.push(Fr.fromBuffer(paddedBuffer.slice(i * 32, (i + 1) * 32)));
    }
    return fields;
}

export async function computeSwapLeaf(
    ciphertextFields: Fr[],
    publicDataTreeRoot: FieldLike,
): Promise<Fr> {
    if (ciphertextFields.length !== MESSAGE_CIPHERTEXT_LEN) {
        throw new Error(`Expected ${MESSAGE_CIPHERTEXT_LEN} ciphertext fields, got ${ciphertextFields.length}`);
    }

    return await poseidon2Hash([
        ...ciphertextFields,
        toFr(publicDataTreeRoot, 'publicDataTreeRoot'),
    ]);
}
