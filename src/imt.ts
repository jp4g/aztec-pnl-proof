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

/**
 * Precomputed zero hashes for each level of a merkle tree.
 *
 * - zeroHashes[0] = Fr.ZERO (empty leaf)
 * - zeroHashes[1] = poseidon2Hash([zero_0, zero_0])
 * - zeroHashes[n] = poseidon2Hash([zero_{n-1}, zero_{n-1}])
 *
 * Useful for sparse merkle trees and padding empty subtrees.
 */
export async function computeZeroHashes(maxDepth: number): Promise<Fr[]> {
    const zeroHashes: Fr[] = [Fr.ZERO];

    for (let i = 1; i <= maxDepth; i++) {
        const prev = zeroHashes[i - 1];
        const hash = await poseidon2Hash([prev, prev]);
        zeroHashes.push(hash);
    }

    return zeroHashes;
}

/**
 * Cached zero hashes - compute once and reuse.
 */
let cachedZeroHashes: Fr[] | null = null;
let cachedMaxDepth = 0;

/**
 * Get zero hashes up to a given depth, with caching.
 */
export async function getZeroHashes(maxDepth: number): Promise<Fr[]> {
    if (cachedZeroHashes && cachedMaxDepth >= maxDepth) {
        return cachedZeroHashes.slice(0, maxDepth + 1);
    }

    cachedZeroHashes = await computeZeroHashes(maxDepth);
    cachedMaxDepth = maxDepth;
    return cachedZeroHashes;
}

/**
 * Build IMT with explicit zero hash padding.
 * Uses precomputed zero hashes instead of recomputing.
 */
export async function buildIMTWithZeroHashes(leaves: Fr[], treeDepth?: number): Promise<Fr> {
    if (leaves.length === 0) {
        return Fr.ZERO;
    }

    // Determine tree depth
    const minDepth = Math.ceil(Math.log2(leaves.length));
    const depth = treeDepth ?? minDepth;
    const numLeaves = Math.pow(2, depth);

    // Get precomputed zero hashes
    const zeroHashes = await getZeroHashes(depth);

    // Pad leaves with zero hash at level 0
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < numLeaves) {
        paddedLeaves.push(zeroHashes[0]);
    }

    // Build tree layer by layer
    let currentLevel = paddedLeaves;
    let level = 0;

    while (currentLevel.length > 1) {
        const nextLevel: Fr[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1];
            const parent = await poseidon2Hash([left, right]);
            nextLevel.push(parent);
        }
        currentLevel = nextLevel;
        level++;
    }

    return currentLevel[0];
}
