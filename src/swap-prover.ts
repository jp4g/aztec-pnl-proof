import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import type { AztecNode } from '@aztec/aztec.js/node';
import { decryptLog } from './decrypt';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { CompleteAddress } from '@aztec/stdlib/contract';

/** Max concurrent lots (must match circuit MAX_LOTS) */
const MAX_LOTS = 8;

/** Generator index for siloing public leaf indices */
const GENERATOR_INDEX__PUBLIC_LEAF_INDEX = 23;

/**
 * A FIFO cost basis lot: amount of tracked token acquired at a given oracle price.
 */
export interface Lot {
    amount: bigint;
    costPerUnit: bigint;
}

/**
 * Configuration for SwapProver
 */
export interface SwapProverConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled individual_swap circuit */
    circuit: CompiledCircuit;
    /** Recipient's complete address */
    recipientCompleteAddress: CompleteAddress;
    /** Master incoming viewing secret key */
    ivskM: Fr;
    /** Aztec node client for fetching price witnesses */
    node: AztecNode;
}

/**
 * Decoded swap data from a single event
 */
export interface SwapData {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
    isExactInput: bigint;
    blockNumber: bigint;
}

/**
 * Result of an individual swap proof
 */
export interface SwapProofResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs (6 Fields) */
    publicInputs: {
        /** Poseidon2 hash of swap data */
        leaf: string;
        /** Absolute value of realized PnL */
        pnl: bigint;
        /** True if PnL is negative (loss) */
        pnlIsNegative: boolean;
        /** Hash of lot state after this swap */
        remainingLotsHash: string;
        /** Hash of lot state before this swap */
        initialLotsHash: string;
        /** PriceFeed contract address */
        priceFeedAddress: string;
    };
    /** Decoded swap parameters */
    swapData: SwapData;
    /** Lot state after this swap (for chaining to next proof) */
    remainingLots: Lot[];
    /** Number of active lots after this swap */
    remainingNumLots: number;
}

/**
 * SwapProver generates a proof for a single swap event.
 * Each swap's encryption is verified, the oracle price is proven via Merkle proof,
 * and FIFO capital gains are computed using i64 arithmetic.
 */
export class SwapProver {
    private config: SwapProverConfig;

    // Lazy-initialized components
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;
    private addressSecret: Fr | null = null;

    constructor(config: SwapProverConfig) {
        this.config = config;
    }

    /**
     * Prove a single swap event with FIFO lot state.
     *
     * @param event - Encrypted swap event
     * @param tokenAddress - The token whose lots we track
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @param initialLots - FIFO lots carried from previous proof
     * @param initialNumLots - Number of active lots
     * @returns Proof with signed PnL and updated lot state
     */
    async prove(
        event: { encryptedLog: Buffer; blockNumber: bigint },
        tokenAddress: Fr,
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        initialLots: Lot[] = [],
        initialNumLots: number = 0,
    ): Promise<SwapProofResult> {
        await this.initialize();

        console.log(`\n--- SwapProver: Proving swap at block ${event.blockNumber} ---`);

        // Decrypt event
        const plaintext = await decryptLog(
            event.encryptedLog,
            this.config.recipientCompleteAddress,
            this.config.ivskM,
        );
        if (!plaintext) throw new Error('Failed to decrypt swap event');

        // Get block header for public data tree root
        const header = await this.config.node.getBlockHeader(Number(event.blockNumber));
        if (!header) throw new Error(`Block header not found for block ${event.blockNumber}`);
        const publicDataTreeRoot = header.state.partial.publicDataTree.root;

        // Only need price witness for the tracked token
        const tokenSlot = await poseidon2Hash([priceFeedAssetsSlot, tokenAddress]);
        const treeIndex = await poseidon2HashWithSeparator(
            [priceFeedAddress, tokenSlot],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );
        const witness = await this.config.node.getPublicDataWitness(
            Number(event.blockNumber), treeIndex,
        );
        if (!witness) throw new Error('Failed to get token price witness');

        console.log(`  token price: ${witness.leafPreimage.leaf.value}`);

        // Build circuit inputs
        const circuitInputs = this.prepareCircuitInputs(
            plaintext, event.encryptedLog, event.blockNumber,
            tokenAddress, priceFeedAddress, priceFeedAssetsSlot,
            publicDataTreeRoot, witness, initialLots, initialNumLots,
        );

        // Execute circuit
        console.log('  Generating witness...');
        const { witness: circuitWitness, returnValue } = await this.noir!.execute(circuitInputs);
        const [leaf, pnlAbs, pnlIsNeg, remainingLotsHash, initialLotsHash, provenPriceFeed] =
            returnValue as [string, string, string, string, string, string];

        const pnlMagnitude = BigInt(pnlAbs);
        const isNegative = BigInt(pnlIsNeg) === 1n;
        const pnl = isNegative ? -pnlMagnitude : pnlMagnitude;

        console.log(`  leaf: ${leaf}, pnl: ${pnl}`);

        // Generate proof
        console.log('  Generating proof...');
        const proof = await this.backend!.generateProof(circuitWitness, {
            verifierTarget: 'noir-recursive',
        });
        const isValid = await this.backend!.verifyProof(proof, {
            verifierTarget: 'noir-recursive',
        });
        if (!isValid) throw new Error('Swap proof verification failed');
        console.log('  Proof verified!');

        // Mirror circuit lot logic in TS for state chaining
        const { lots: remainingLots, numLots: remainingNumLots } =
            this.computeRemainingLots(plaintext, tokenAddress, initialLots, initialNumLots, witness);

        const swapData: SwapData = {
            tokenIn: plaintext[2].toString(),
            tokenOut: plaintext[3].toString(),
            amountIn: plaintext[4].toBigInt(),
            amountOut: plaintext[5].toBigInt(),
            isExactInput: plaintext[6].toBigInt(),
            blockNumber: event.blockNumber,
        };

        return {
            proof: proof.proof,
            publicInputs: {
                leaf,
                pnl: pnlMagnitude,
                pnlIsNegative: isNegative,
                remainingLotsHash,
                initialLotsHash,
                priceFeedAddress: provenPriceFeed,
            },
            swapData,
            remainingLots,
            remainingNumLots,
        };
    }

    /**
     * Build circuit inputs for a single swap.
     */
    private prepareCircuitInputs(
        plaintext: Fr[],
        encryptedLog: Buffer,
        blockNumber: bigint,
        tokenAddress: Fr,
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        publicDataTreeRoot: Fr,
        witness: any,
        initialLots: Lot[],
        initialNumLots: number,
    ): Record<string, unknown> {
        // Plaintext bytes: 7 fields * 32 bytes = 224 bytes
        const plaintextBytes: string[] = [];
        for (const field of plaintext) {
            const buf = field.toBuffer();
            for (const byte of buf) {
                plaintextBytes.push(byte.toString());
            }
        }

        // Ciphertext: skip 32-byte tag
        const ciphertextWithoutTag = encryptedLog.slice(32);
        const ephPkX = Fr.fromBuffer(ciphertextWithoutTag.slice(0, 32));

        // Remaining 16 fields -> unpack to 31 bytes each = 496 bytes
        const ciphertextBytes: string[] = [];
        const restBuffer = ciphertextWithoutTag.slice(32);
        const paddedRest = Buffer.alloc(16 * 32);
        restBuffer.copy(paddedRest, 0, 0, Math.min(restBuffer.length, paddedRest.length));
        for (let f = 0; f < 16; f++) {
            for (let j = 1; j < 32; j++) {
                ciphertextBytes.push(paddedRest[f * 32 + j].toString());
            }
        }

        // Lot state (pad to MAX_LOTS)
        const lotsInput: Record<string, string>[] = [];
        for (let i = 0; i < MAX_LOTS; i++) {
            if (i < initialLots.length && initialLots[i].amount > 0n) {
                lotsInput.push({
                    amount: initialLots[i].amount.toString(),
                    cost_per_unit: initialLots[i].costPerUnit.toString(),
                });
            } else {
                lotsInput.push({ amount: '0', cost_per_unit: '0' });
            }
        }

        return {
            plaintext_bytes: plaintextBytes,
            eph_pk_x: ephPkX.toString(),
            ciphertext_bytes: ciphertextBytes,
            ivsk_app: this.addressSecret!.toString(),
            block_number: new Fr(blockNumber).toString(),
            token_address: tokenAddress.toString(),
            price_feed_address: priceFeedAddress.toString(),
            price_feed_assets_slot: priceFeedAssetsSlot.toString(),
            public_data_tree_root: publicDataTreeRoot.toString(),
            price_witness: this.formatPriceWitness(witness),
            initial_lots: lotsInput,
            initial_num_lots: initialNumLots.toString(),
        };
    }

    /**
     * Mirror the circuit's lot update logic in TypeScript for state chaining.
     */
    private computeRemainingLots(
        plaintext: Fr[],
        tokenAddress: Fr,
        initialLots: Lot[],
        initialNumLots: number,
        witness: any,
    ): { lots: Lot[]; numLots: number } {
        const tokenOut = plaintext[3];
        const amountIn = plaintext[4].toBigInt();
        const amountOut = plaintext[5].toBigInt();
        const tokenPrice = witness.leafPreimage.leaf.value.toBigInt();

        const isBuy = tokenOut.equals(tokenAddress);

        // Clone lots (pad to MAX_LOTS)
        const lots: Lot[] = [];
        for (let i = 0; i < MAX_LOTS; i++) {
            if (i < initialLots.length) {
                lots.push({ ...initialLots[i] });
            } else {
                lots.push({ amount: 0n, costPerUnit: 0n });
            }
        }
        let numLots = initialNumLots;

        if (isBuy) {
            lots[numLots] = { amount: amountOut, costPerUnit: tokenPrice };
            numLots++;
        } else {
            let remaining = amountIn;
            for (let j = 0; j < MAX_LOTS; j++) {
                if (remaining > 0n && lots[j].amount > 0n) {
                    const consumed = remaining < lots[j].amount ? remaining : lots[j].amount;
                    lots[j].amount -= consumed;
                    remaining -= consumed;
                }
            }
            // Compact: remove empty lots, shift to front
            const compacted: Lot[] = lots.filter(l => l.amount > 0n);
            numLots = compacted.length;
            while (compacted.length < MAX_LOTS) {
                compacted.push({ amount: 0n, costPerUnit: 0n });
            }
            return { lots: compacted, numLots };
        }

        return { lots, numLots };
    }

    private formatPriceWitness(witness: any): Record<string, unknown> {
        return {
            leaf_preimage: {
                slot: witness.leafPreimage.leaf.slot.toString(),
                value: witness.leafPreimage.leaf.value.toString(),
                next_slot: witness.leafPreimage.nextKey.toString(),
                next_index: new Fr(BigInt(witness.leafPreimage.nextIndex)).toString(),
            },
            witness_index: new Fr(BigInt(witness.index)).toString(),
            witness_path: witness.siblingPath.toFields().map((f: Fr) => f.toString()),
        };
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing SwapProver...');
        this.noir = new Noir(this.config.circuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(this.config.circuit.bytecode, this.config.bb);

        const preaddress = await this.config.recipientCompleteAddress.getPreaddress();
        this.addressSecret = await computeAddressSecret(preaddress, this.config.ivskM);

        console.log('SwapProver initialized');
    }
}
