import { Fr } from '@aztec/foundation/curves/bn254';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { getZeroHashes } from './imt';
import type { SwapProver, SwapProofResult, SwapData, Lot } from './swap-prover';

/** Number of public inputs per child proof (6 Fields) */
const NUM_PUBLIC_INPUTS = 6;

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
    /** SwapProver instance (for generating individual swap proofs) */
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
        /** Absolute PnL value */
        pnl: bigint;
        /** True if PnL is negative (loss) */
        pnlIsNegative: boolean;
        /** Hash of lot state after all swaps */
        remainingLotsHash: string;
        /** Hash of lot state before first swap (empty lots) */
        initialLotsHash: string;
        /** PriceFeed contract address */
        priceFeedAddress: string;
    };
    /** Signed PnL (negative means loss) */
    signedPnl: bigint;
    /** Individual swap data from each leaf */
    swapData: SwapData[];
    /** Final lot state (for downstream use) */
    remainingLots: Lot[];
    /** Number of active lots after all swaps */
    remainingNumLots: number;
}

/**
 * Internal proof artifact for tree building
 */
interface ProofArtifact {
    proof: Uint8Array;
    proofAsFields: string[];
    publicInputs: string[]; // [leaf, pnl, pnl_is_negative, remaining_lots_hash, initial_lots_hash, price_feed_address]
}

/**
 * SwapProofTree generates individual swap proofs (with FIFO lot chaining)
 * then aggregates them into a single recursive summary proof.
 *
 * Each swap proof tracks one token's FIFO cost basis lots.
 * The summary tree builds a merkle root of swap leaf hashes
 * and sums signed PnL across all swaps.
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
     * Prove all swap events for a single tracked token and aggregate
     * into a single summary proof.
     *
     * Events must be sorted chronologically. Lot state chains through
     * each proof in order.
     *
     * @param events - Encrypted swap events sorted by block number
     * @param tokenAddress - The token whose FIFO lots we track
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @returns Aggregated proof with merkle root and signed PnL
     */
    async prove(
        events: { encryptedLog: Buffer; blockNumber: bigint }[],
        tokenAddress: Fr,
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
    ): Promise<SwapProofTreeResult> {
        await this.initialize();

        console.log(`\n=== SwapProofTree: Aggregating ${events.length} swap proofs ===`);

        // Step 1: Prove each swap individually, chaining lot state
        const swapResults: SwapProofResult[] = [];
        const swapArtifacts: ProofArtifact[] = [];

        let currentLots: Lot[] = [];
        let currentNumLots = 0;

        for (let i = 0; i < events.length; i++) {
            console.log(`\n--- Proving swap ${i + 1}/${events.length} ---`);

            const result = await this.config.swapProver.prove(
                events[i],
                tokenAddress,
                priceFeedAddress,
                priceFeedAssetsSlot,
                currentLots,
                currentNumLots,
            );

            // Extract leaf vkey artifacts from the first proof
            if (!this.leafVkAsFields) {
                const artifacts = await this.leafBackend!.generateRecursiveProofArtifacts(
                    result.proof,
                    NUM_PUBLIC_INPUTS,
                );
                this.leafVkAsFields = artifacts.vkAsFields;
                this.leafVkHash = artifacts.vkHash;
                console.log(`  Leaf vkey hash: ${this.leafVkHash}`);
            }

            const proofAsFields = this.proofBytesToFields(result.proof);

            swapResults.push(result);
            swapArtifacts.push({
                proof: result.proof,
                proofAsFields,
                publicInputs: [
                    result.publicInputs.leaf,
                    result.publicInputs.pnl.toString(),
                    result.publicInputs.pnlIsNegative ? '1' : '0',
                    result.publicInputs.remainingLotsHash,
                    result.publicInputs.initialLotsHash,
                    result.publicInputs.priceFeedAddress,
                ],
            });

            // Chain lot state to next proof
            currentLots = result.remainingLots;
            currentNumLots = result.remainingNumLots;
        }

        console.log(`\nIndividual proofs generated: ${swapArtifacts.length}`);

        // Step 2: Build recursive tree from individual proofs
        // Always wrap in summary tree for uniform proof structure (privacy)
        const finalProof = await this.buildTree(swapArtifacts);
        console.log(`\nFinal proof generated!`);

        const [root, pnlAbs, pnlIsNeg, remainingLotsHash, initialLotsHash, priceFeedAddr] =
            finalProof.publicInputs;
        const pnlMagnitude = BigInt(pnlAbs);
        const isNegative = BigInt(pnlIsNeg) === 1n;

        return {
            proof: finalProof.proof,
            publicInputs: {
                root,
                pnl: pnlMagnitude,
                pnlIsNegative: isNegative,
                remainingLotsHash,
                initialLotsHash,
                priceFeedAddress: priceFeedAddr,
            },
            signedPnl: isNegative ? -pnlMagnitude : pnlMagnitude,
            swapData: swapResults.map(r => r.swapData),
            remainingLots: currentLots,
            remainingNumLots: currentNumLots,
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

        // If only 1 proof, still wrap it in the summary tree for uniform structure
        if (proofs.length === 1) {
            console.log('\n=== Wrapping single proof in summary tree ===');
            return await this.combineProofs(proofs[0], null, 0);
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
        const emptyPublicInputs = ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0'];
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
        const [root, pnlAbs, pnlIsNeg, remainingLotsHash, initialLotsHash, priceFeedAddr] =
            returnValue as [string, string, string, string, string, string];

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
        const pnlMagnitude = BigInt(pnlAbs);
        const isNeg = BigInt(pnlIsNeg) === 1n;
        const signedPnl = isNeg ? -pnlMagnitude : pnlMagnitude;

        console.log(`  Root: ${root}`);
        console.log(`  PnL so far: ${signedPnl} (${isNeg ? 'loss' : 'gain'})`);
        console.log(`  Proof: valid`);

        return {
            proof: proof.proof,
            proofAsFields,
            publicInputs: [root, pnlAbs, pnlIsNeg, remainingLotsHash, initialLotsHash, priceFeedAddr],
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
        const emptyPublicInputs = ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0'];

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
