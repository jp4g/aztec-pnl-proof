import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import type { Lot } from './types';
import { MAX_LOTS, LOT_TREE_HEIGHT, NUM_SLOTS } from './constants';

/**
 * Per-token lot data stored at each leaf of the lot state tree.
 */
interface TokenLotData {
    tokenAddress: Fr;
    lots: Lot[];
    numLots: number;
}

/**
 * LotStateTree manages a height-3 merkle tree of per-token lot arrays.
 * Each leaf is hash_lots(token_address, lots, num_lots) or 0 for empty.
 * Supports 8 token slots (2^3).
 */
export class LotStateTree {
    private leaves: Fr[];
    private tokenMap: Map<string, number>; // token address string -> leaf index
    private lotData: Map<string, TokenLotData>; // token address string -> lot data
    private cachedLayers: Fr[][] | null = null;
    private claimedSlots = new Set<number>();

    constructor() {
        this.leaves = new Array(NUM_SLOTS).fill(Fr.ZERO);
        this.tokenMap = new Map();
        this.lotData = new Map();
    }

    /**
     * Get lots for a token (or empty if unassigned).
     */
    getLots(tokenAddress: Fr): { lots: Lot[]; numLots: number; leafIndex: number } {
        const key = tokenAddress.toString();
        const index = this.tokenMap.get(key);
        if (index === undefined) {
            // Token not yet assigned
            const emptyLots: Lot[] = [];
            for (let i = 0; i < MAX_LOTS; i++) {
                emptyLots.push({ amount: 0n, costPerUnit: 0n });
            }
            return { lots: emptyLots, numLots: 0, leafIndex: -1 };
        }
        const data = this.lotData.get(key)!;
        // Pad to MAX_LOTS
        const lots: Lot[] = [];
        for (let i = 0; i < MAX_LOTS; i++) {
            if (i < data.lots.length) {
                lots.push({ ...data.lots[i] });
            } else {
                lots.push({ amount: 0n, costPerUnit: 0n });
            }
        }
        return { lots, numLots: data.numLots, leafIndex: index };
    }

    /**
     * Compute all tree layers from leaves up to root.
     */
    private async computeLayers(): Promise<Fr[][]> {
        if (this.cachedLayers) return this.cachedLayers;
        const layers: Fr[][] = [this.leaves.slice()];
        for (let level = 0; level < LOT_TREE_HEIGHT; level++) {
            const prev = layers[level];
            const next: Fr[] = [];
            for (let i = 0; i < prev.length; i += 2) {
                next.push(await poseidon2Hash([prev[i], prev[i + 1]]));
            }
            layers.push(next);
        }
        this.cachedLayers = layers;
        return layers;
    }

    /**
     * Get the sibling path for a leaf index.
     * Computes the merkle path bottom-up.
     */
    async getSiblingPath(leafIndex: number): Promise<Fr[]> {
        const layers = await this.computeLayers();
        const path: Fr[] = [];
        for (let level = 0; level < LOT_TREE_HEIGHT; level++) {
            const idx = leafIndex >> level;
            const siblingIdx = idx ^ 1;
            path.push(layers[level][siblingIdx]);
        }
        return path;
    }

    /**
     * Update a leaf hash directly.
     */
    updateLeaf(leafIndex: number, newHash: Fr): void {
        this.leaves[leafIndex] = newHash;
        this.cachedLayers = null;
    }

    /**
     * Get the current root of the tree.
     */
    async getRoot(): Promise<Fr> {
        const layers = await this.computeLayers();
        return layers[layers.length - 1][0];
    }

    /**
     * Assign a token to the next empty slot. Returns the slot index.
     * If already assigned, returns existing index.
     */
    assignSlot(tokenAddress: Fr): number {
        const key = tokenAddress.toString();
        const existing = this.tokenMap.get(key);
        if (existing !== undefined) return existing;

        // Find next empty slot
        for (let i = 0; i < NUM_SLOTS; i++) {
            if (this.leaves[i].equals(Fr.ZERO) && !this.claimedSlots.has(i)) {
                this.tokenMap.set(key, i);
                this.claimedSlots.add(i);
                this.lotData.set(key, {
                    tokenAddress,
                    lots: [],
                    numLots: 0,
                });
                return i;
            }
        }
        throw new Error('Lot state tree is full (no empty slots)');
    }

    /**
     * Update the internal lot data for a token and recompute its leaf hash.
     */
    async setLots(tokenAddress: Fr, lots: Lot[], numLots: number): Promise<void> {
        const key = tokenAddress.toString();
        let index = this.tokenMap.get(key);
        if (index === undefined) {
            index = this.assignSlot(tokenAddress);
        }
        this.lotData.set(key, { tokenAddress, lots: lots.slice(0, numLots), numLots });
        this.leaves[index] = await LotStateTree.hashLots(tokenAddress, numLots, lots);
        this.cachedLayers = null;
    }

    /**
     * Compute the leaf hash matching the circuit's hash_lots function.
     * preimage = [token_address, num_lots, lot0.amount, lot0.cost_per_unit, lot1.amount, ...]
     */
    static async hashLots(tokenAddress: Fr, numLots: number, lots: Lot[]): Promise<Fr> {
        if (numLots === 0) {
            return Fr.ZERO;
        }
        const preimageLen = MAX_LOTS * 2 + 2;
        const preimage: Fr[] = new Array(preimageLen).fill(Fr.ZERO);
        preimage[0] = tokenAddress;
        preimage[1] = new Fr(BigInt(numLots));
        for (let i = 0; i < MAX_LOTS; i++) {
            if (i < lots.length) {
                preimage[2 + i * 2] = new Fr(lots[i].amount);
                preimage[2 + i * 2 + 1] = new Fr(lots[i].costPerUnit);
            }
        }
        return poseidon2Hash(preimage);
    }

}
