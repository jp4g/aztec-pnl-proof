import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import type { AztecNode } from '@aztec/aztec.js/node';

/** Generator index for siloing public leaf indices (matches Noir constant) */
const GENERATOR_INDEX__PUBLIC_LEAF_INDEX = 23;

/**
 * Configuration for SpotPriceProver
 */
export interface SpotPriceProverConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled spot_price circuit */
    circuit: CompiledCircuit;
    /** Aztec node client for fetching witnesses */
    node: AztecNode;
}

/**
 * Result of a spot price proof
 */
export interface SpotPriceProofResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs */
    publicInputs: {
        price: bigint;
        blockNumber: bigint;
        publicDataTreeRoot: string;
        ammAddress: string;
        token0Address: string;
        token1Address: string;
    };
}

/**
 * SpotPriceProver generates a proof of an AMM's spot price at a historical block.
 *
 * It fetches public data witnesses from an Aztec node, computes the derived storage
 * slots for the AMM's balances in each token contract, and generates a ZK proof.
 */
export class SpotPriceProver {
    private config: SpotPriceProverConfig;
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;

    constructor(config: SpotPriceProverConfig) {
        this.config = config;
    }

    /**
     * Prove the spot price of an AMM at a given block.
     */
    async prove(
        ammAddress: Fr,
        token0Address: Fr,
        token1Address: Fr,
        blockNumber: number,
        tokenPublicBalancesSlot: Fr,
        pricePrecision: bigint = 10n ** 18n,
    ): Promise<SpotPriceProofResult> {
        await this.initialize();

        console.log(`\n=== SpotPriceProver: Proving at block ${blockNumber} ===`);
        console.log(`  AMM: ${ammAddress}`);
        console.log(`  Token0: ${token0Address}`);
        console.log(`  Token1: ${token1Address}`);

        // 1. Get block header to extract the public data tree root
        const header = await this.config.node.getBlockHeader(blockNumber);
        if (!header) {
            throw new Error(`Block header not found for block ${blockNumber}`);
        }
        const publicDataTreeRoot = header.state.partial.publicDataTree.root;
        console.log(`  Public data tree root: ${publicDataTreeRoot}`);

        // 2. Compute derived storage slots (same math as the circuit)
        const token0MapSlot = await poseidon2Hash([tokenPublicBalancesSlot, ammAddress]);
        const token1MapSlot = await poseidon2Hash([tokenPublicBalancesSlot, ammAddress]);

        const token0TreeIndex = await poseidon2HashWithSeparator(
            [token0Address, token0MapSlot],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );
        const token1TreeIndex = await poseidon2HashWithSeparator(
            [token1Address, token1MapSlot],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );

        console.log(`  Token0 tree index: ${token0TreeIndex}`);
        console.log(`  Token1 tree index: ${token1TreeIndex}`);

        // 3. Fetch public data witnesses
        const token0Witness = await this.config.node.getPublicDataWitness(blockNumber, token0TreeIndex);
        if (!token0Witness) {
            throw new Error('Failed to get public data witness for token0');
        }

        const token1Witness = await this.config.node.getPublicDataWitness(blockNumber, token1TreeIndex);
        if (!token1Witness) {
            throw new Error('Failed to get public data witness for token1');
        }

        console.log(`  Token0 witness index: ${token0Witness.index}`);
        console.log(`  Token0 leaf slot: ${token0Witness.leafPreimage.leaf.slot}`);
        console.log(`  Token0 leaf value: ${token0Witness.leafPreimage.leaf.value}`);
        console.log(`  Token1 witness index: ${token1Witness.index}`);
        console.log(`  Token1 leaf slot: ${token1Witness.leafPreimage.leaf.slot}`);
        console.log(`  Token1 leaf value: ${token1Witness.leafPreimage.leaf.value}`);

        // 4. Format circuit inputs
        const circuitInputs = {
            amm_address: ammAddress.toString(),
            token0_address: token0Address.toString(),
            token1_address: token1Address.toString(),
            block_number: new Fr(BigInt(blockNumber)).toString(),
            public_data_tree_root: publicDataTreeRoot.toString(),
            token_public_balances_slot: tokenPublicBalancesSlot.toString(),
            // Token0 witness
            token0_leaf_preimage: {
                slot: token0Witness.leafPreimage.leaf.slot.toString(),
                value: token0Witness.leafPreimage.leaf.value.toString(),
                next_slot: token0Witness.leafPreimage.nextKey.toString(),
                next_index: new Fr(BigInt(token0Witness.leafPreimage.nextIndex)).toString(),
            },
            token0_witness_index: new Fr(BigInt(token0Witness.index)).toString(),
            token0_witness_path: token0Witness.siblingPath.toFields().map((f: Fr) => f.toString()),
            // Token1 witness
            token1_leaf_preimage: {
                slot: token1Witness.leafPreimage.leaf.slot.toString(),
                value: token1Witness.leafPreimage.leaf.value.toString(),
                next_slot: token1Witness.leafPreimage.nextKey.toString(),
                next_index: new Fr(BigInt(token1Witness.leafPreimage.nextIndex)).toString(),
            },
            token1_witness_index: new Fr(BigInt(token1Witness.index)).toString(),
            token1_witness_path: token1Witness.siblingPath.toFields().map((f: Fr) => f.toString()),
            // Price precision
            price_precision: new Fr(pricePrecision).toString(),
        };

        // 5. Generate witness and proof
        console.log('\n  Generating witness...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [price, provenBlockNumber, provenRoot, provenAmm, provenToken0, provenToken1] =
            returnValue as [string, string, string, string, string, string];

        console.log(`  Proven price: ${BigInt(price)}`);
        console.log('  Generating proof...');

        const proof = await this.backend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
        const isValid = await this.backend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
        if (!isValid) {
            throw new Error('Spot price proof verification failed');
        }
        console.log('  Proof verified!');

        return {
            proof: proof.proof,
            publicInputs: {
                price: BigInt(price),
                blockNumber: BigInt(provenBlockNumber),
                publicDataTreeRoot: provenRoot,
                ammAddress: provenAmm,
                token0Address: provenToken0,
                token1Address: provenToken1,
            },
        };
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing SpotPriceProver...');
        this.noir = new Noir(this.config.circuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(this.config.circuit.bytecode, this.config.bb);
        console.log('SpotPriceProver initialized');
    }
}
