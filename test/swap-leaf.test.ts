import { describe, test } from 'node:test';
import { expect } from 'expect';
import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { computeSwapLeaf } from '@privpnl/proof/swap-leaf';

describe('swap leaf', () => {
    test('commits to ciphertext and public data tree root', async () => {
        const ciphertext = Array.from({ length: 15 }, (_, i) => new Fr(BigInt(i + 1)));
        const publicDataTreeRoot = new Fr(456n);

        const leaf = await computeSwapLeaf(ciphertext, publicDataTreeRoot);
        const manual = await poseidon2Hash([...ciphertext, publicDataTreeRoot]);

        expect(leaf.toString()).toBe(manual.toString());

        const differentRoot = await computeSwapLeaf(ciphertext, new Fr(789n));
        expect(differentRoot.toString()).not.toBe(leaf.toString());
    });
});
