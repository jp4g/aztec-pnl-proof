import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';

/**
 * Convert a ciphertext buffer to an array of field elements.
 * Each field is 32 bytes.
 */
export function ciphertextToFields(ciphertext: Buffer): Fr[] {
    const fields: Fr[] = [];
    for (let i = 0; i < ciphertext.length; i += 32) {
        const chunk = ciphertext.slice(i, Math.min(i + 32, ciphertext.length));
        // Pad chunk to 32 bytes if needed
        const padded = Buffer.alloc(32);
        chunk.copy(padded);
        fields.push(Fr.fromBuffer(padded));
    }
    return fields;
}

/**
 * Hash a ciphertext into a single leaf value using poseidon2.
 */
export async function hashCiphertextToLeaf(ciphertext: Buffer): Promise<Fr> {
    const fields = ciphertextToFields(ciphertext);
    return await poseidon2Hash(fields);
}

/**
 * Build a binary incremental merkle tree from leaves.
 * Returns the root.
 *
 * - Pads to next power of 2 with Fr.ZERO
 * - Hashes pairs with poseidon2([left, right])
 */
export async function buildIMT(leaves: Fr[]): Promise<Fr> {
    if (leaves.length === 0) {
        return Fr.ZERO;
    }

    // Pad to next power of 2
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < nextPow2) {
        paddedLeaves.push(Fr.ZERO);
    }

    // Build tree layer by layer
    let currentLevel = paddedLeaves;

    while (currentLevel.length > 1) {
        const nextLevel: Fr[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1];
            const parent = await poseidon2Hash([left, right]);
            nextLevel.push(parent);
        }
        currentLevel = nextLevel;
    }

    return currentLevel[0];
}

/**
 * Build IMT from ciphertexts.
 * Convenience function that hashes each ciphertext to a leaf, then builds tree.
 */
export async function buildIMTFromCiphertexts(ciphertexts: Buffer[]): Promise<Fr> {
    const leaves = await Promise.all(ciphertexts.map(c => hashCiphertextToLeaf(c)));
    return await buildIMT(leaves);
}
