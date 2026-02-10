import { Fr } from '@aztec/foundation/curves/bn254';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { getZeroHashes } from './imt';
import type { SwapProver, SwapProofResult, SwapData } from './swap-prover';

/** Number of public inputs per child proof */
const NUM_PUBLIC_INPUTS = 5;

/** Max swaps per batch (must match circuit MAX_SWAPS) */
const BATCH_SIZE = 8;

/**
 * Configuration for SwapProofTree
 */
export interface SwapProofTreeConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled individual_swap circuit (for vkey extraction) */
    leafCircuit: CompiledCircuit;
    /** Compiled swap_summary_tree circuit */
    summaryCircuit: CompiledCircuit;
    /** SwapProver instance (for generating batch proofs) */
    swapProver: SwapProver;
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
        /** Summary circuit vkey hash */
        vkeyHash: string;
        /** Total value_in across all swaps */
        totalValueIn: bigint;
        /** Total value_out across all swaps */
        totalValueOut: bigint;
        /** PriceFeed contract address */
        priceFeedAddress: string;
    };
    /** PnL = totalValueOut - totalValueIn */
    pnl: bigint;
    /** Individual swap data from each leaf */
    swapData: SwapData[];
}

/**
 * Internal proof artifact for tree building
 */
interface ProofArtifact {
    proof: Uint8Array;
    proofAsFields: string[];
    publicInputs: string[]; // [root, vkey_marker, value_in, value_out, price_feed_address]
}

/**
 * SwapProofTree aggregates batch swap proofs into a single
 * recursive summary proof with a merkle root and total PnL.
 *
 * Each batch proof covers up to 8 swaps. For <= 8 swaps total,
 * only a single batch proof is needed (no summary tree).
 */
export class SwapProofTree {
    private config: SwapProofTreeConfig;

    private leafBackend: UltraHonkBackend | null = null;
    private summaryNoir: Noir | null = null;
    private summaryBackend: UltraHonkBackend | null = null;
    private zeroHashes: Fr[] | null = null;

    // VKey artifacts (computed once)
    private leafVkAsFields: string[] | null = null;
    private leafVkHash: string | null = null;
    private summaryVkAsFields: string[] | null = null;
    private summaryVkHash: string | null = null;

    constructor(config: SwapProofTreeConfig) {
        this.config = config;
    }

    /**
     * Prove all swap events and aggregate into a single summary proof.
     *
     * @param events - Array of { encryptedLog, blockNumber } for each swap
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @returns Aggregated proof with merkle root and total PnL
     */
    async prove(
        events: { encryptedLog: Buffer; blockNumber: bigint }[],
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
    ): Promise<SwapProofTreeResult> {
        await this.initialize();

        console.log(`\n=== SwapProofTree: Aggregating ${events.length} swap proofs ===`);

        // Step 1: Prove batches of up to BATCH_SIZE swaps
        const batchResults: SwapProofResult[] = [];
        const batchArtifacts: ProofArtifact[] = [];

        for (let i = 0; i < events.length; i += BATCH_SIZE) {
            const batch = events.slice(i, Math.min(i + BATCH_SIZE, events.length));
            const batchIdx = Math.floor(i / BATCH_SIZE);
            console.log(`\n--- Proving batch ${batchIdx + 1} (${batch.length} swaps) ---`);

            const result = await this.config.swapProver.prove(
                batch,
                priceFeedAddress,
                priceFeedAssetsSlot,
            );

            // Extract vkey artifacts from the first batch proof
            if (!this.leafVkAsFields) {
                const artifacts = await this.leafBackend!.generateRecursiveProofArtifacts(
                    result.proof,
                    NUM_PUBLIC_INPUTS,
                );
                this.leafVkAsFields = artifacts.vkAsFields;
                this.leafVkHash = artifacts.vkHash;
                console.log(`  Batch vkey hash: ${this.leafVkHash}`);
            }

            const proofAsFields = this.proofBytesToFields(result.proof);

            batchResults.push(result);
            batchArtifacts.push({
                proof: result.proof,
                proofAsFields,
                publicInputs: [
                    result.publicInputs.root,
                    result.publicInputs.vkeyMarker,
                    result.publicInputs.totalValueIn.toString(),
                    result.publicInputs.totalValueOut.toString(),
                    result.publicInputs.priceFeedAddress,
                ],
            });
        }

        console.log(`\nBatch proofs generated: ${batchArtifacts.length}`);

        // Step 2: Build recursive tree from batch proofs
        // Always wrap in summary tree for uniform proof structure (privacy)
        const finalProof = await this.buildTree(batchArtifacts);
        console.log(`\nFinal proof generated!`);

        const [root, vkeyHash, totalValueIn, totalValueOut, priceFeedAddr] = finalProof.publicInputs;
        const totalIn = BigInt(totalValueIn);
        const totalOut = BigInt(totalValueOut);

        return {
            proof: finalProof.proof,
            publicInputs: {
                root,
                vkeyHash,
                totalValueIn: totalIn,
                totalValueOut: totalOut,
                priceFeedAddress: priceFeedAddr,
            },
            pnl: totalOut - totalIn,
            swapData: batchResults.flatMap(r => r.swapData),
        };
    }

    private async initialize(): Promise<void> {
        if (this.summaryNoir) return;

        console.log('Initializing SwapProofTree...');

        this.leafBackend = new UltraHonkBackend(
            this.config.leafCircuit.bytecode,
            this.config.bb,
        );

        this.summaryNoir = new Noir(this.config.summaryCircuit);
        await this.summaryNoir.init();

        this.summaryBackend = new UltraHonkBackend(
            this.config.summaryCircuit.bytecode,
            this.config.bb,
        );

        this.zeroHashes = await getZeroHashes(20);

        console.log('SwapProofTree initialized');
    }

    /**
     * Build the tree by recursively combining proofs
     */
    private async buildTree(proofs: ProofArtifact[]): Promise<ProofArtifact> {
        let currentLevel = proofs;
        let level = 0;

        while (currentLevel.length > 1) {
            console.log(
                `\n=== Building level ${level + 1} (${currentLevel.length} proofs -> ${Math.ceil(currentLevel.length / 2)}) ===`,
            );

            const nextLevel: ProofArtifact[] = [];

            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : null;

                console.log(
                    `\n--- Combining pair ${Math.floor(i / 2) + 1} (${right ? 'full' : 'odd, using zero hash'}) ---`,
                );

                const combined = await this.combineProofs(left, right, level);
                nextLevel.push(combined);
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
        let vkAsFields: string[];
        let vkHash: string;

        if (isLeafLevel) {
            vkAsFields = this.leafVkAsFields!;
            vkHash = this.leafVkHash!;
        } else {
            if (!this.summaryVkAsFields) {
                throw new Error('Summary vkey not yet computed');
            }
            vkAsFields = this.summaryVkAsFields;
            vkHash = this.summaryVkHash!;
        }

        const hasRight = right !== null;
        const emptyProof = new Array(left.proofAsFields.length).fill('0x0');
        const emptyPublicInputs = ['0x0', '0x0', '0x0', '0x0', '0x0'];
        const zeroLeafForLevel = this.zeroHashes![level];

        // Pre-compute summary vkey hash if needed
        if (!this.summaryVkHash) {
            await this.precomputeSummaryVkHash(left, vkAsFields, vkHash);
        }

        const summaryInputs = {
            verification_key: vkAsFields,
            vkey_hash: vkHash,
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
            leaf_vkey_hash: this.leafVkHash!,
            summary_vkey_hash: this.summaryVkHash!,
        };

        const { witness, returnValue } = await this.summaryNoir!.execute(summaryInputs);
        const [root, outVkeyHash, totalValueIn, totalValueOut, priceFeedAddr] =
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

        // Get summary vkey artifacts (only once, after first summary proof)
        if (!this.summaryVkAsFields) {
            const artifacts = await this.summaryBackend!.generateRecursiveProofArtifacts(
                proof.proof,
                NUM_PUBLIC_INPUTS,
            );
            this.summaryVkAsFields = artifacts.vkAsFields;
            this.summaryVkHash = artifacts.vkHash;
        }

        const proofAsFields = this.proofBytesToFields(proof.proof);

        console.log(`  Root: ${root}`);
        console.log(`  PnL so far: value_in=${BigInt(totalValueIn)}, value_out=${BigInt(totalValueOut)}`);
        console.log(`  Proof: valid`);

        return {
            proof: proof.proof,
            proofAsFields,
            publicInputs: [root, outVkeyHash, totalValueIn, totalValueOut, priceFeedAddr],
        };
    }

    /**
     * Convert proof bytes to field array (32 bytes per field)
     */
    private proofBytesToFields(proofBytes: Uint8Array): string[] {
        const fields: string[] = [];
        for (let i = 0; i < proofBytes.length; i += 32) {
            const chunk = proofBytes.slice(i, i + 32);
            const hex = '0x' + Buffer.from(chunk).toString('hex');
            fields.push(hex);
        }
        return fields;
    }

    /**
     * Pre-compute summary vkey hash by generating a throwaway proof.
     */
    private async precomputeSummaryVkHash(
        sampleProof: ProofArtifact,
        vkAsFields: string[],
        vkHash: string,
    ): Promise<void> {
        console.log('  Pre-computing summary vkey hash...');

        const emptyProof = new Array(sampleProof.proofAsFields.length).fill('0x0');
        const emptyPublicInputs = ['0x0', '0x0', '0x0', '0x0', '0x0'];

        const throwawayInputs = {
            verification_key: vkAsFields,
            vkey_hash: vkHash,
            proof_left: sampleProof.proofAsFields,
            proof_right: {
                _is_some: false,
                _value: emptyProof,
            },
            public_inputs_left: sampleProof.publicInputs,
            public_inputs_right: {
                _is_some: false,
                _value: emptyPublicInputs,
            },
            zero_leaf_hint: {
                _is_some: true,
                _value: this.zeroHashes![0].toString(),
            },
            leaf_vkey_hash: vkHash,
            summary_vkey_hash: '0x0', // Placeholder - not checked at level 0
        };

        const { witness } = await this.summaryNoir!.execute(throwawayInputs);
        const proof = await this.summaryBackend!.generateProof(witness, {
            verifierTarget: 'noir-recursive',
        });

        const artifacts = await this.summaryBackend!.generateRecursiveProofArtifacts(
            proof.proof,
            NUM_PUBLIC_INPUTS,
        );
        this.summaryVkAsFields = artifacts.vkAsFields;
        this.summaryVkHash = artifacts.vkHash;

        console.log(`  Summary vkey hash: ${this.summaryVkHash}`);
    }
}
