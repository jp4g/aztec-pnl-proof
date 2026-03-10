import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';

/**
 * Precomputed zero hashes for each level of a merkle tree.
 *
 * - zeroHashes[0] = Fr.ZERO (empty leaf)
 * - zeroHashes[n] = poseidon2Hash([zero_{n-1}, zero_{n-1}])
 */
async function computeZeroHashes(maxDepth: number): Promise<Fr[]> {
    const zeroHashes: Fr[] = [Fr.ZERO];

    for (let i = 1; i <= maxDepth; i++) {
        const prev = zeroHashes[i - 1];
        const hash = await poseidon2Hash([prev, prev]);
        zeroHashes.push(hash);
    }

    return zeroHashes;
}

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
