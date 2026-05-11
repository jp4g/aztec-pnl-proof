import { describe, test } from 'node:test';
import { expect } from 'expect';
import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { computeSwapLeaf } from '@privpnl/proof/swap-leaf';

describe('swap leaf', () => {
    test('commits to ciphertext, block number, and public data tree root', async () => {
        const ciphertext = Array.from({ length: 15 }, (_, i) => new Fr(BigInt(i + 1)));
        const blockNumber = 123n;
        const publicDataTreeRoot = new Fr(456n);

        const leaf = await computeSwapLeaf(ciphertext, blockNumber, publicDataTreeRoot);
        const manual = await poseidon2HashWithSeparator(
            [...ciphertext, new Fr(blockNumber), publicDataTreeRoot],
            0,
        );

        expect(leaf.toString()).toBe(manual.toString());

        const differentBlock = await computeSwapLeaf(ciphertext, blockNumber + 1n, publicDataTreeRoot);
        expect(differentBlock.toString()).not.toBe(leaf.toString());

        const differentRoot = await computeSwapLeaf(ciphertext, blockNumber, new Fr(789n));
        expect(differentRoot.toString()).not.toBe(leaf.toString());
    });
});
