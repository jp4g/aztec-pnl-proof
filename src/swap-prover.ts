import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import type { AztecNode } from '@aztec/aztec.js/node';
import { decryptLog } from './decrypt';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { CompleteAddress } from '@aztec/stdlib/contract';

/** Max swaps per batch proof (must match circuit MAX_SWAPS) */
const MAX_SWAPS = 8;

/** Generator index for siloing public leaf indices */
const GENERATOR_INDEX__PUBLIC_LEAF_INDEX = 23;

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
 * Result of a batch swap proof (up to 8 swaps)
 */
export interface SwapProofResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs: (root, vkey_marker, total_value_in, total_value_out, price_feed_address) */
    publicInputs: {
        /** Merkle sub-root of up to 8 leaf hashes */
        root: string;
        /** Vkey marker: 0 for batch proofs */
        vkeyMarker: string;
        /** Sum of amount_in * price_in across all swaps */
        totalValueIn: bigint;
        /** Sum of amount_out * price_out across all swaps */
        totalValueOut: bigint;
        /** PriceFeed contract address */
        priceFeedAddress: string;
    };
    /** Decoded swap parameters for each event in the batch */
    swapData: SwapData[];
}

/**
 * SwapProver generates a batch proof for up to 8 swap events.
 * Each swap's encryption is verified, prices are proven via Merkle proofs,
 * and the batch is aggregated into a sub-tree root with summed values.
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
     * Prove a batch of swap events (up to MAX_SWAPS).
     *
     * @param events - Array of swap events (1 to 8)
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @returns Batch proof with sub-tree root and summed PnL values
     */
    async prove(
        events: { encryptedLog: Buffer; blockNumber: bigint }[],
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
    ): Promise<SwapProofResult> {
        if (events.length === 0 || events.length > MAX_SWAPS) {
            throw new Error(`Expected 1-${MAX_SWAPS} events, got ${events.length}`);
        }
        await this.initialize();

        console.log(`\n=== SwapProver: Proving batch of ${events.length} swap events ===`);

        // Decrypt all events and fetch witnesses
        const perSwap: {
            plaintext: Fr[];
            encryptedLog: Buffer;
            blockNumber: bigint;
            publicDataTreeRoot: Fr;
            witnessIn: any;
            witnessOut: any;
        }[] = [];

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            console.log(`\n--- Decrypting swap ${i + 1}/${events.length} ---`);

            const plaintext = await decryptLog(
                event.encryptedLog,
                this.config.recipientCompleteAddress,
                this.config.ivskM,
            );
            if (!plaintext) {
                throw new Error(`Failed to decrypt swap event ${i}`);
            }

            const header = await this.config.node.getBlockHeader(Number(event.blockNumber));
            if (!header) {
                throw new Error(`Block header not found for block ${event.blockNumber}`);
            }
            const publicDataTreeRoot = header.state.partial.publicDataTree.root;

            const slotIn = await poseidon2Hash([priceFeedAssetsSlot, plaintext[2]]);
            const slotOut = await poseidon2Hash([priceFeedAssetsSlot, plaintext[3]]);
            const treeIndexIn = await poseidon2HashWithSeparator(
                [priceFeedAddress, slotIn],
                GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
            );
            const treeIndexOut = await poseidon2HashWithSeparator(
                [priceFeedAddress, slotOut],
                GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
            );

            const witnessIn = await this.config.node.getPublicDataWitness(Number(event.blockNumber), treeIndexIn);
            if (!witnessIn) throw new Error(`Failed to get price-in witness for swap ${i}`);
            const witnessOut = await this.config.node.getPublicDataWitness(Number(event.blockNumber), treeIndexOut);
            if (!witnessOut) throw new Error(`Failed to get price-out witness for swap ${i}`);

            console.log(`  price_in: ${witnessIn.leafPreimage.leaf.value}`);
            console.log(`  price_out: ${witnessOut.leafPreimage.leaf.value}`);

            perSwap.push({
                plaintext,
                encryptedLog: event.encryptedLog,
                blockNumber: event.blockNumber,
                publicDataTreeRoot,
                witnessIn,
                witnessOut,
            });
        }

        // Build circuit inputs (pad to MAX_SWAPS)
        const circuitInputs = this.prepareCircuitInputs(
            perSwap,
            priceFeedAddress,
            priceFeedAssetsSlot,
        );

        // Generate witness
        console.log('\n  Generating witness...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [root, vkeyMarker, totalValueIn, totalValueOut, provenPriceFeed] =
            returnValue as [string, string, string, string, string];

        console.log(`  Root: ${root}`);
        console.log(`  total_value_in: ${BigInt(totalValueIn)}, total_value_out: ${BigInt(totalValueOut)}`);

        // Generate proof
        console.log('  Generating proof...');
        const proof = await this.backend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
        const isValid = await this.backend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
        if (!isValid) {
            throw new Error('Batch swap proof verification failed');
        }
        console.log('  Proof verified!');

        // Collect swap data for all events
        const swapData: SwapData[] = perSwap.map(s => ({
            tokenIn: s.plaintext[2].toString(),
            tokenOut: s.plaintext[3].toString(),
            amountIn: BigInt(s.plaintext[4].toBigInt()),
            amountOut: BigInt(s.plaintext[5].toBigInt()),
            isExactInput: BigInt(s.plaintext[6].toBigInt()),
            blockNumber: s.blockNumber,
        }));

        return {
            proof: proof.proof,
            publicInputs: {
                root,
                vkeyMarker,
                totalValueIn: BigInt(totalValueIn),
                totalValueOut: BigInt(totalValueOut),
                priceFeedAddress: provenPriceFeed,
            },
            swapData,
        };
    }

    /**
     * Build circuit inputs for a batch of swaps, padding unused slots with zeros.
     */
    private prepareCircuitInputs(
        swaps: {
            plaintext: Fr[];
            encryptedLog: Buffer;
            blockNumber: bigint;
            publicDataTreeRoot: Fr;
            witnessIn: any;
            witnessOut: any;
        }[],
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
    ): Record<string, unknown> {
        const allPlaintextBytes: string[][] = [];
        const allEphPkX: string[] = [];
        const allCiphertextBytes: string[][] = [];
        const allBlockNumbers: string[] = [];
        const allPublicDataTreeRoots: string[] = [];
        const allPriceWitnesses: Record<string, unknown>[][] = [];

        for (let i = 0; i < MAX_SWAPS; i++) {
            if (i < swaps.length) {
                const s = swaps[i];

                // Plaintext bytes: 7 fields * 32 bytes = 224 bytes
                const plaintextBytes: string[] = [];
                for (const field of s.plaintext) {
                    const buf = field.toBuffer();
                    for (const byte of buf) {
                        plaintextBytes.push(byte.toString());
                    }
                }
                allPlaintextBytes.push(plaintextBytes);

                // Ciphertext: skip 32-byte tag
                const ciphertextWithoutTag = s.encryptedLog.slice(32);
                const ephPkX = Fr.fromBuffer(ciphertextWithoutTag.slice(0, 32));
                allEphPkX.push(ephPkX.toString());

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
                allCiphertextBytes.push(ciphertextBytes);

                allBlockNumbers.push(new Fr(s.blockNumber).toString());
                allPublicDataTreeRoots.push(s.publicDataTreeRoot.toString());

                allPriceWitnesses.push([
                    this.formatPriceWitness(s.witnessIn),
                    this.formatPriceWitness(s.witnessOut),
                ]);
            } else {
                // Padding: zeros for inactive slots
                allPlaintextBytes.push(new Array(224).fill('0'));
                allEphPkX.push('0');
                allCiphertextBytes.push(new Array(496).fill('0'));
                allBlockNumbers.push('0');
                allPublicDataTreeRoots.push('0');
                allPriceWitnesses.push([
                    this.zeroPriceWitness(),
                    this.zeroPriceWitness(),
                ]);
            }
        }

        return {
            num_swaps: swaps.length.toString(),
            plaintext_bytes: allPlaintextBytes,
            eph_pk_x: allEphPkX,
            ciphertext_bytes: allCiphertextBytes,
            ivsk_app: this.addressSecret!.toString(),
            block_numbers: allBlockNumbers,
            price_feed_address: priceFeedAddress.toString(),
            price_feed_assets_slot: priceFeedAssetsSlot.toString(),
            public_data_tree_roots: allPublicDataTreeRoots,
            price_witnesses: allPriceWitnesses,
        };
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

    private zeroPriceWitness(): Record<string, unknown> {
        return {
            leaf_preimage: {
                slot: '0',
                value: '0',
                next_slot: '0',
                next_index: '0',
            },
            witness_index: '0',
            witness_path: new Array(40).fill('0'),
        };
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing SwapProver...');
        this.noir = new Noir(this.config.circuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(this.config.circuit.bytecode, this.config.bb);

        // Compute address secret (ivsk_app)
        const preaddress = await this.config.recipientCompleteAddress.getPreaddress();
        this.addressSecret = await computeAddressSecret(preaddress, this.config.ivskM);

        console.log('SwapProver initialized');
    }
}
