import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import type { AztecNode } from '@aztec/aztec.js/node';
import { decryptLog } from './decrypt';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import { LotStateTree } from './lot-state-tree';

/** Parse a potentially negative hex string like "-0x1a" into a BigInt */
function parseSignedHex(s: string): bigint {
    if (s.startsWith('-0x') || s.startsWith('-0X')) {
        return -BigInt(s.slice(1));
    }
    return BigInt(s);
}

/** Max concurrent lots (must match circuit MAX_LOTS) */
const MAX_LOTS = 32;

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
    /** Public outputs (6 values) */
    publicInputs: {
        /** Poseidon2 hash of ciphertext (auditor-verifiable) */
        leaf: string;
        /** Signed PnL (i64) */
        pnl: bigint;
        /** Lot state tree root after this swap */
        remainingLotStateRoot: string;
        /** Lot state tree root before this swap */
        initialLotStateRoot: string;
        /** PriceFeed contract address */
        priceFeedAddress: string;
        /** Block number of this swap */
        blockNumber: bigint;
    };
    /** Decoded swap parameters */
    swapData: SwapData;
}

/**
 * SwapProver generates a proof for a single swap event.
 * Each swap updates two leaves in the lot state tree (sell-side and buy-side tokens).
 * The lot state tree is mutated in-place.
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
     * Prove a single swap event with multi-token lot state tree.
     *
     * @param event - Encrypted swap event
     * @param lotStateTree - Multi-token lot state tree (mutated in-place)
     * @param priceFeedAddress - PriceFeed contract address
     * @param priceFeedAssetsSlot - Storage slot of the PriceFeed `assets` map
     * @param previousBlockNumber - Block number from previous proof (0 for first)
     * @returns Proof with signed PnL (lot state tree is updated in-place)
     */
    async prove(
        event: { encryptedLog: Buffer; blockNumber: bigint },
        lotStateTree: LotStateTree,
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        previousBlockNumber: bigint = 0n,
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

        // Extract token addresses from plaintext
        const tokenIn = plaintext[2];
        const tokenOut = plaintext[3];
        const amountIn = plaintext[4].toBigInt();
        const amountOut = plaintext[5].toBigInt();

        console.log(`  token_in: ${tokenIn}, token_out: ${tokenOut}`);
        console.log(`  amount_in: ${amountIn}, amount_out: ${amountOut}`);

        // Ensure both tokens have slots in the tree
        const sellIndex = lotStateTree.assignSlot(tokenIn);
        const buyIndex = lotStateTree.assignSlot(tokenOut);

        // Get block header for public data tree root
        const header = await this.config.node.getBlockHeader(Number(event.blockNumber));
        if (!header) throw new Error(`Block header not found for block ${event.blockNumber}`);
        const publicDataTreeRoot = header.state.partial.publicDataTree.root;

        // Get price witnesses for BOTH tokens
        const sellPriceWitness = await this.getPriceWitness(
            priceFeedAddress, priceFeedAssetsSlot, tokenIn, event.blockNumber,
        );
        const buyPriceWitness = await this.getPriceWitness(
            priceFeedAddress, priceFeedAssetsSlot, tokenOut, event.blockNumber,
        );

        console.log(`  sell token price: ${sellPriceWitness.leafPreimage.leaf.value}`);
        console.log(`  buy token price: ${buyPriceWitness.leafPreimage.leaf.value}`);

        // Get sell-side lots and sibling path from INITIAL tree state
        const sellData = lotStateTree.getLots(tokenIn);
        const sellSiblingPath = await lotStateTree.getSiblingPath(sellIndex);
        const initialRoot = await lotStateTree.getRoot();

        // Mirror circuit sell-side logic in TS to update the tree
        const sellPrice = sellPriceWitness.leafPreimage.leaf.value.toBigInt();
        const { lots: newSellLots, numLots: newSellNum } =
            this.consumeLotsFIFO(sellData.lots, sellData.numLots, amountIn, sellPrice);

        // Update sell leaf in local tree
        await lotStateTree.setLots(tokenIn, newSellLots, newSellNum);

        // Get buy-side lots and sibling path from INTERMEDIATE tree state
        const buyData = lotStateTree.getLots(tokenOut);
        const buySiblingPath = await lotStateTree.getSiblingPath(buyIndex);

        // Mirror circuit buy-side logic in TS
        const buyPrice = buyPriceWitness.leafPreimage.leaf.value.toBigInt();
        const newBuyLots = [...buyData.lots];
        newBuyLots[buyData.numLots] = { amount: amountOut, costPerUnit: buyPrice };
        const newBuyNum = buyData.numLots + 1;

        // Update buy leaf in local tree
        await lotStateTree.setLots(tokenOut, newBuyLots, newBuyNum);

        // Parse ciphertext into fields (matching on-chain representation)
        const ciphertextFields = this.parseCiphertextFields(event.encryptedLog);

        // Build circuit inputs
        const circuitInputs = this.prepareCircuitInputs(
            plaintext, ciphertextFields, event.blockNumber,
            initialRoot.toString(),
            sellData.lots, sellData.numLots, sellIndex, sellSiblingPath,
            buyData.lots, buyData.numLots, buyIndex, buySiblingPath,
            priceFeedAddress, priceFeedAssetsSlot,
            publicDataTreeRoot, sellPriceWitness, buyPriceWitness,
            previousBlockNumber,
        );

        // Execute circuit
        console.log('  Generating witness...');
        const { witness: circuitWitness, returnValue } = await this.noir!.execute(circuitInputs);
        const [leaf, pnlStr, remainingRoot, initRoot, provenPriceFeed, provenBlockNumber] =
            returnValue as [string, string, string, string, string, string];

        const pnl = parseSignedHex(pnlStr);

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

        const swapData: SwapData = {
            tokenIn: plaintext[2].toString(),
            tokenOut: plaintext[3].toString(),
            amountIn,
            amountOut,
            isExactInput: plaintext[6].toBigInt(),
            blockNumber: event.blockNumber,
        };

        return {
            proof: proof.proof,
            publicInputs: {
                leaf,
                pnl,
                remainingLotStateRoot: remainingRoot,
                initialLotStateRoot: initRoot,
                priceFeedAddress: provenPriceFeed,
                blockNumber: BigInt(provenBlockNumber),
            },
            swapData,
        };
    }

    /**
     * Build circuit inputs for a single swap with dual-token lot tree.
     */
    private prepareCircuitInputs(
        plaintext: Fr[],
        ciphertextFields: Fr[],
        blockNumber: bigint,
        initialLotStateRoot: string,
        sellLots: Lot[],
        sellNumLots: number,
        sellLeafIndex: number,
        sellSiblingPath: Fr[],
        buyLots: Lot[],
        buyNumLots: number,
        buyLeafIndex: number,
        buySiblingPath: Fr[],
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        publicDataTreeRoot: Fr,
        sellPriceWitness: any,
        buyPriceWitness: any,
        previousBlockNumber: bigint,
    ): Record<string, unknown> {
        // Format lot arrays (pad to MAX_LOTS)
        const formatLots = (lots: Lot[]): Record<string, string>[] => {
            const result: Record<string, string>[] = [];
            for (let i = 0; i < MAX_LOTS; i++) {
                if (i < lots.length && lots[i].amount > 0n) {
                    result.push({
                        amount: lots[i].amount.toString(),
                        cost_per_unit: lots[i].costPerUnit.toString(),
                    });
                } else {
                    result.push({ amount: '0', cost_per_unit: '0' });
                }
            }
            return result;
        };

        return {
            plaintext: plaintext.map(f => f.toString()),
            ciphertext: ciphertextFields.map(f => f.toString()),
            ivsk_app: this.addressSecret!.toString(),
            block_number: new Fr(blockNumber).toString(),
            initial_lot_state_root: initialLotStateRoot,
            sell_lots: formatLots(sellLots),
            sell_num_lots: sellNumLots.toString(),
            sell_leaf_index: new Fr(BigInt(sellLeafIndex)).toString(),
            sell_sibling_path: sellSiblingPath.map(f => f.toString()),
            buy_lots: formatLots(buyLots),
            buy_num_lots: buyNumLots.toString(),
            buy_leaf_index: new Fr(BigInt(buyLeafIndex)).toString(),
            buy_sibling_path: buySiblingPath.map(f => f.toString()),
            price_feed_address: priceFeedAddress.toString(),
            price_feed_assets_slot: priceFeedAssetsSlot.toString(),
            public_data_tree_root: publicDataTreeRoot.toString(),
            sell_price_witness: this.formatPriceWitness(sellPriceWitness),
            buy_price_witness: this.formatPriceWitness(buyPriceWitness),
            previous_block_number: new Fr(previousBlockNumber).toString(),
        };
    }

    /**
     * Consume lots FIFO and return updated lots (mirrors circuit logic).
     */
    private consumeLotsFIFO(
        lots: Lot[],
        numLots: number,
        sellAmount: bigint,
        _sellPrice: bigint,
    ): { lots: Lot[]; numLots: number } {
        const lotsCopy: Lot[] = [];
        for (let i = 0; i < MAX_LOTS; i++) {
            if (i < lots.length) {
                lotsCopy.push({ ...lots[i] });
            } else {
                lotsCopy.push({ amount: 0n, costPerUnit: 0n });
            }
        }

        let remaining = sellAmount;
        for (let j = 0; j < MAX_LOTS; j++) {
            if (remaining > 0n && lotsCopy[j].amount > 0n) {
                const consumed = remaining < lotsCopy[j].amount ? remaining : lotsCopy[j].amount;
                lotsCopy[j].amount -= consumed;
                remaining -= consumed;
            }
        }

        // Compact
        const compacted = lotsCopy.filter(l => l.amount > 0n);
        const newNumLots = compacted.length;
        while (compacted.length < MAX_LOTS) {
            compacted.push({ amount: 0n, costPerUnit: 0n });
        }
        return { lots: compacted, numLots: newNumLots };
    }

    /**
     * Parse an encrypted log buffer into ciphertext fields (matching on-chain representation).
     * Skips the 32-byte tag, then reads 17 x 32-byte chunks as Fr fields.
     */
    private parseCiphertextFields(encryptedLog: Buffer): Fr[] {
        const MESSAGE_CIPHERTEXT_LEN = 17;
        const ciphertextWithoutTag = encryptedLog.slice(32);
        const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
        ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

        const fields: Fr[] = [];
        for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
            const chunk = paddedBuffer.slice(i * 32, (i + 1) * 32);
            fields.push(Fr.fromBuffer(chunk));
        }
        return fields;
    }

    private async getPriceWitness(
        priceFeedAddress: Fr,
        priceFeedAssetsSlot: Fr,
        tokenAddress: Fr,
        blockNumber: bigint,
    ): Promise<any> {
        const tokenSlot = await poseidon2Hash([priceFeedAssetsSlot, tokenAddress]);
        const treeIndex = await poseidon2HashWithSeparator(
            [priceFeedAddress, tokenSlot],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );
        const witness = await this.config.node.getPublicDataWitness(
            Number(blockNumber), treeIndex,
        );
        if (!witness) throw new Error(`Failed to get price witness for token ${tokenAddress}`);
        return witness;
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
