import { Fr } from '@aztec/foundation/curves/bn254';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { getZeroHashes } from './imt';
import type { SwapEventInput, SwapProver, SwapProofResult, SwapData } from './swap-prover';
import { LotStateTree } from './lot-state-tree';
import { parseSignedHex, proofBytesToFields } from './utils';
import { log } from './logger';

/** Encode a signed i64 bigint as its two's complement u64 Field string */
export function i64ToField(val: bigint): string {
    if (val < 0n) {
        return ((1n << 64n) + val).toString();
    }
    return val.toString();
}

/** Decode a two's complement u64 Field value back to signed i64 */
export function fieldToI64(val: bigint): bigint {
    if (val >= (1n << 63n)) {
        return val - (1n << 64n);
    }
    return val;
}

/** Precomputed verification key artifacts */
export interface VkeyArtifacts {
    vkAsFields: string[];
    vkHash: string;
}

/**
 * Configuration for SwapProofTree
 */
export interface SwapProofTreeConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled swap_summary_tree circuit */
    summaryCircuit: CompiledCircuit;
    /** SwapProver instance (for generating individual swap proofs) */
    swapProver: SwapProver;
    /** Precomputed verification keys */
    vkeys: {
        leaf: VkeyArtifacts;
        summary: VkeyArtifacts;
    };
    /** If set, save debug data (inputs/witnesses/proofs) to this path after each combineProofs call */
    debugOutputPath?: string;
}

/** Debug snapshot of a single combineProofs call */
export interface DebugCombineCall {
    level: number;
    isLeafLevel: boolean;
    hasRight: boolean;
    summaryInputs: Record<string, unknown>;
    witness: string; // hex-encoded
    proof: string;   // hex-encoded
    publicInputs: string[];
}

/** Debug snapshot of the full proof tree run */
export interface DebugProofTreeData {
    vkeys: { leaf: VkeyArtifacts; summary: VkeyArtifacts };
    leafProofs: Array<{
        index: number;
        proof: string;       // hex-encoded
        proofAsFields: string[];
        publicInputs: string[];
    }>;
    combineCalls: DebugCombineCall[];
}

/**
 * Result of the recursive aggregation
 */
export interface SwapProofTreeResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs from final proof */
    publicInputs: {
        /** Merkle root of all leaf hashes */
        root: string;
        /** Signed PnL (i64) */
        pnl: bigint;
        /** Lot state tree root after all swaps */
        remainingLotStateRoot: string;
        /** Lot state tree root before first swap */
        initialLotStateRoot: string;
        /** PriceFeed contract address */
        priceFeedAddress: string;
    };
    /** Signed PnL (negative means loss) */
    signedPnl: bigint;
    /** Individual swap data from each leaf */
    swapData: SwapData[];
    /** Final lot state tree */
    lotStateTree: LotStateTree;
}

/**
 * Internal proof artifact for tree building
 */
interface ProofArtifact {
    proof: Uint8Array;
    proofAsFields: string[];
    publicInputs: string[]; // 5 fields
}

/**
 * SwapProofTree generates individual swap proofs (with multi-token lot chaining)
 * then aggregates them into a single recursive summary proof.
 *
 * Each swap proof updates two leaves in the lot state tree (sell-side and buy-side).
 * The summary tree builds a merkle root of swap leaf hashes,
 * sums signed PnL, and enforces price feed consistency.
 */
export class SwapProofTree {
    private config: SwapProofTreeConfig;

    private summaryNoir: Noir | null = null;
    private summaryBackend: UltraHonkBackend | null = null;
    private zeroHashes: Fr[] | null = null;

    /** Accumulated debug data (only when debugOutputPath is set) */
    private debugData: DebugProofTreeData | null = null;

    constructor(config: SwapProofTreeConfig) {
        this.config = config;
    }

    private initDebug(): void {
        if (!this.config.debugOutputPath) return;
        this.debugData = {
            vkeys: this.config.vkeys,
            leafProofs: [],
            combineCalls: [],
        };
    }

    private async saveDebug(): Promise<void> {
        if (!this.debugData || !this.config.debugOutputPath) return;
        if (typeof globalThis.process !== 'undefined' && typeof globalThis.window === 'undefined') {
            const { writeFileSync } = await import(/* webpackIgnore: true */ 'node:fs');
            writeFileSync(this.config.debugOutputPath, JSON.stringify(this.debugData, null, 2));
            log(`[debug] Saved proof tree data to ${this.config.debugOutputPath}`);
        }
    }

    /**
     * Prove all swap events and aggregate into a single summary proof.
     *
     * Events must be sorted chronologically. The lot state tree is mutated
     * in-place through each sequential proof.
     *
     * @param events - Encrypted swap events sorted by the auditor
     * @param lotStateTree - Multi-token lot state tree (mutated in-place)
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @returns Aggregated proof with merkle root and signed PnL
     */
    async prove(
        events: SwapEventInput[],
        lotStateTree: LotStateTree,
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        onProgress?: (step: string, current: number, total: number, detail?: { level: number; nodeIndex: number; nodesInLevel: number }) => void,
    ): Promise<SwapProofTreeResult> {
        await this.initialize();
        this.initDebug();

        log(`\n=== SwapProofTree: Aggregating ${events.length} swap proofs ===`);

        // Step 1: Prove each swap individually, chaining lot state tree
        const swapResults: SwapProofResult[] = [];
        const swapArtifacts: ProofArtifact[] = [];

        for (let i = 0; i < events.length; i++) {
            log(`\n--- Proving swap ${i + 1}/${events.length} ---`);
            onProgress?.('swap', i + 1, events.length);

            const result = await this.config.swapProver.prove(
                events[i],
                lotStateTree,
                priceFeedAddress,
                priceFeedAssetsSlot,
            );

            const proofAsFields = proofBytesToFields(result.proof);

            const pubInputs = [
                result.publicInputs.leaf,
                i64ToField(result.publicInputs.pnl),
                result.publicInputs.remainingLotStateRoot,
                result.publicInputs.initialLotStateRoot,
                result.publicInputs.priceFeedAddress,
            ];

            swapResults.push(result);
            swapArtifacts.push({
                proof: result.proof,
                proofAsFields,
                publicInputs: pubInputs,
            });

            // Save leaf proof debug data
            if (this.debugData) {
                this.debugData.leafProofs.push({
                    index: i,
                    proof: Buffer.from(result.proof).toString('hex'),
                    proofAsFields,
                    publicInputs: pubInputs,
                });
                await this.saveDebug();
            }
        }

        log(`\nIndividual proofs generated: ${swapArtifacts.length}`);

        // Step 2: Build recursive tree from individual proofs
        const finalProof = await this.buildTree(swapArtifacts, onProgress);
        log(`\nFinal proof generated!`);

        const [root, pnlStr, remainingLotStateRoot, initialLotStateRoot, priceFeedAddr] =
            finalProof.publicInputs;
        const pnl = fieldToI64(BigInt(pnlStr));

        return {
            proof: finalProof.proof,
            publicInputs: {
                root,
                pnl,
                remainingLotStateRoot,
                initialLotStateRoot,
                priceFeedAddress: priceFeedAddr,
            },
            signedPnl: pnl,
            swapData: swapResults.map(r => r.swapData),
            lotStateTree,
        };
    }

    async verifyProof(
        proof: Uint8Array,
        publicInputs: {
            root: string;
            pnl: string;
            remainingLotStateRoot: string;
            initialLotStateRoot: string;
            priceFeedAddress: string;
        },
    ): Promise<boolean> {
        await this.initialize();

        return this.summaryBackend!.verifyProof(
            {
                proof,
                publicInputs: [
                    publicInputs.root,
                    publicInputs.pnl,
                    publicInputs.remainingLotStateRoot,
                    publicInputs.initialLotStateRoot,
                    publicInputs.priceFeedAddress,
                ],
            },
            { verifierTarget: 'noir-recursive' },
        );
    }

    private async initialize(): Promise<void> {
        if (this.summaryNoir) return;

        log('Initializing SwapProofTree...');

        this.summaryNoir = new Noir(this.config.summaryCircuit);
        await this.summaryNoir.init();

        this.summaryBackend = new UltraHonkBackend(
            this.config.summaryCircuit.bytecode,
            this.config.bb,
        );

        this.zeroHashes = await getZeroHashes(20);

        log(`  Leaf vkey hash: ${this.config.vkeys.leaf.vkHash}`);
        log(`  Summary vkey hash: ${this.config.vkeys.summary.vkHash}`);
        log('SwapProofTree initialized');
    }

    /**
     * Build the tree by recursively combining proofs
     */
    private async buildTree(proofs: ProofArtifact[], onProgress?: (step: string, current: number, total: number, detail?: { level: number; nodeIndex: number; nodesInLevel: number }) => void): Promise<ProofArtifact> {
        let currentLevel = proofs;
        let level = 0;
        let combinesDone = 0;

        // Compute total combines across all levels
        let totalCombines = 0;
        let temp = proofs.length;
        while (temp > 1) {
            totalCombines += Math.ceil(temp / 2);
            temp = Math.ceil(temp / 2);
        }
        if (proofs.length === 1) totalCombines = 1;

        // If only 1 proof, still wrap it in the summary tree for uniform structure
        if (proofs.length === 1) {
            log('\n=== Wrapping single proof in summary tree ===');
            onProgress?.('aggregate', 0, 1, { level: 0, nodeIndex: 0, nodesInLevel: 1 });
            return await this.combineProofs(proofs[0], null, 0);
        }

        while (currentLevel.length > 1) {
            const pairsInLevel = Math.ceil(currentLevel.length / 2);
            log(
                `\n=== Building level ${level + 1} (${currentLevel.length} proofs -> ${pairsInLevel}) ===`,
            );

            const nextLevel: ProofArtifact[] = [];

            for (let i = 0; i < currentLevel.length; i += 2) {
                const pairIndex = Math.floor(i / 2);
                const left = currentLevel[i];
                const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : null;

                log(
                    `\n--- Combining pair ${pairIndex + 1}/${pairsInLevel} (${right ? 'full' : 'odd, using zero hash'}) ---`,
                );

                onProgress?.('aggregate', combinesDone, totalCombines, { level, nodeIndex: pairIndex, nodesInLevel: pairsInLevel });

                const combined = await this.combineProofs(left, right, level);
                nextLevel.push(combined);
                combinesDone++;
            }

            currentLevel = nextLevel;
            level++;
        }

        return currentLevel[0];
    }

    /**
     * Combine two proofs using the summary circuit
     */
    private async combineProofs(
        left: ProofArtifact,
        right: ProofArtifact | null,
        level: number,
    ): Promise<ProofArtifact> {
        const isLeafLevel = level === 0;
        const vk = isLeafLevel ? this.config.vkeys.leaf : this.config.vkeys.summary;

        const hasRight = right !== null;
        const emptyProof = new Array(left.proofAsFields.length).fill('0x0');
        const emptyPublicInputs = ['0x0', '0x0', '0x0', '0x0', '0x0'];
        const zeroLeafForLevel = this.zeroHashes![level];

        const summaryInputs = {
            verification_key: vk.vkAsFields,
            vkey_hash: vk.vkHash,
            proof_left: left.proofAsFields,
            proof_right: {
                _is_some: hasRight,
                _value: hasRight ? right!.proofAsFields : emptyProof,
            },
            public_inputs_left: left.publicInputs,
            public_inputs_right: {
                _is_some: hasRight,
                _value: hasRight ? right!.publicInputs : emptyPublicInputs,
            },
            zero_leaf_hint: {
                _is_some: !hasRight,
                _value: hasRight ? '0x0' : zeroLeafForLevel.toString(),
            },
            leaf_vkey_hash: this.config.vkeys.leaf.vkHash,
            summary_vkey_hash: this.config.vkeys.summary.vkHash,
        };

        const { witness, returnValue } = await this.summaryNoir!.execute(summaryInputs);
        const [root, pnlStr, remainingLotStateRoot, initialLotStateRoot, priceFeedAddr] =
            returnValue as [string, string, string, string, string];

        const proof = await this.summaryBackend!.generateProof(witness, {
            verifierTarget: 'noir-recursive',
        });
        const isValid = await this.summaryBackend!.verifyProof(proof, {
            verifierTarget: 'noir-recursive',
        });
        if (!isValid) {
            throw new Error('Invalid summary proof');
        }

        const proofAsFields = proofBytesToFields(proof.proof);
        const pnl = parseSignedHex(pnlStr);

        log(`  Root: ${root}`);
        log(`  PnL so far: ${pnl}`);
        log(`  Proof: valid`);

        const combinedPublicInputs = [root, i64ToField(pnl), remainingLotStateRoot, initialLotStateRoot, priceFeedAddr];

        // Save debug data for this combine call
        if (this.debugData) {
            this.debugData.combineCalls.push({
                level,
                isLeafLevel,
                hasRight,
                summaryInputs,
                witness: Buffer.from(witness).toString('hex'),
                proof: Buffer.from(proof.proof).toString('hex'),
                publicInputs: combinedPublicInputs,
            });
            await this.saveDebug();
        }

        return {
            proof: proof.proof,
            proofAsFields,
            publicInputs: combinedPublicInputs,
        };
    }

}
