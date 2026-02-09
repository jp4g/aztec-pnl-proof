import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import type { AztecNode } from '@aztec/aztec.js/node';

// Generator indices (must match circuit constants)
const GENERATOR_INDEX__NOTE_HASH = 1;
const GENERATOR_INDEX__UNIQUE_NOTE_HASH = 3;
const GENERATOR_INDEX__SILOED_NOTE_HASH = 4;
const GENERATOR_INDEX__OUTER_NULLIFIER = 7;
const GENERATOR_INDEX__NOTE_NULLIFIER = 53;

/**
 * Configuration for NoteCreationProver
 */
export interface NoteCreationProverConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled note_creation circuit */
    circuit: CompiledCircuit;
    /** Aztec node client for fetching witnesses */
    node: AztecNode;
}

/**
 * Note data needed to generate the proof
 */
export interface NoteData {
    /** The u128 value stored in the note (as bigint) */
    value: bigint;
    /** Note owner address (as Fr) */
    owner: Fr;
    /** Storage slot for the balance set */
    storageSlot: Fr;
    /** Note randomness */
    randomness: Fr;
    /** Note nonce (assigned by protocol) */
    noteNonce: Fr;
    /** Token contract address */
    contractAddress: Fr;
    /** Owner's app-scoped nullifier secret key */
    nskApp: Fr;
}

/**
 * Result of a note creation proof
 */
export interface NoteCreationProofResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs */
    publicInputs: {
        noteValue: bigint;
        beforeBlockNumber: bigint;
        inclusionBlockNumber: bigint;
        contractAddress: string;
        noteHashTreeRoot: string;
        nullifierTreeRoot: string;
    };
}

/**
 * NoteCreationProver generates a proof that a private note was created after
 * a specific block, exists at a later block, and has not been nullified.
 */
export class NoteCreationProver {
    private config: NoteCreationProverConfig;
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;

    constructor(config: NoteCreationProverConfig) {
        this.config = config;
    }

    /**
     * Prove note creation between two blocks.
     *
     * @param noteData - The note's private data
     * @param beforeBlock - Block number where the note did NOT exist
     * @param inclusionBlock - Block number where the note EXISTS and is unspent
     */
    async prove(
        noteData: NoteData,
        beforeBlock: number,
        inclusionBlock: number,
    ): Promise<NoteCreationProofResult> {
        await this.initialize();

        console.log(`\n=== NoteCreationProver ===`);
        console.log(`  Before block: ${beforeBlock}`);
        console.log(`  Inclusion block: ${inclusionBlock}`);
        console.log(`  Contract: ${noteData.contractAddress}`);
        console.log(`  Value: ${noteData.value}`);

        // 1. Compute the unique_note_hash (same chain as circuit)
        const commitment = await poseidon2HashWithSeparator(
            [noteData.owner, noteData.storageSlot, noteData.randomness],
            GENERATOR_INDEX__NOTE_HASH,
        );

        const noteHash = await poseidon2HashWithSeparator(
            [commitment, new Fr(noteData.value)],
            GENERATOR_INDEX__NOTE_HASH,
        );

        const siloedNoteHash = await poseidon2HashWithSeparator(
            [noteData.contractAddress, noteHash],
            GENERATOR_INDEX__SILOED_NOTE_HASH,
        );

        const uniqueNoteHash = await poseidon2HashWithSeparator(
            [noteData.noteNonce, siloedNoteHash],
            GENERATOR_INDEX__UNIQUE_NOTE_HASH,
        );

        console.log(`  Unique note hash: ${uniqueNoteHash}`);

        // 2. Get block headers
        const beforeHeader = await this.config.node.getBlockHeader(beforeBlock);
        if (!beforeHeader) {
            throw new Error(`Block header not found for before block ${beforeBlock}`);
        }
        const beforeTreeSize = beforeHeader.state.partial.noteHashTree.nextAvailableLeafIndex;

        const inclusionHeader = await this.config.node.getBlockHeader(inclusionBlock);
        if (!inclusionHeader) {
            throw new Error(`Block header not found for inclusion block ${inclusionBlock}`);
        }
        const noteHashTreeRoot = inclusionHeader.state.partial.noteHashTree.root;
        const nullifierTreeRoot = inclusionHeader.state.partial.nullifierTree.root;

        console.log(`  Before tree size: ${beforeTreeSize}`);
        console.log(`  Note hash tree root: ${noteHashTreeRoot}`);
        console.log(`  Nullifier tree root: ${nullifierTreeRoot}`);

        // 3. Get note hash membership witness at inclusion block
        const noteWitness = await this.config.node.getNoteHashMembershipWitness(
            inclusionBlock,
            uniqueNoteHash,
        );
        if (!noteWitness) {
            throw new Error('Note hash not found in tree at inclusion block');
        }

        console.log(`  Note leaf index: ${noteWitness.leafIndex}`);

        // 4. Compute siloed nullifier for non-inclusion check
        const innerNullifier = await poseidon2HashWithSeparator(
            [uniqueNoteHash, noteData.nskApp],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        );

        const siloedNullifier = await poseidon2HashWithSeparator(
            [noteData.contractAddress, innerNullifier],
            GENERATOR_INDEX__OUTER_NULLIFIER,
        );

        console.log(`  Siloed nullifier: ${siloedNullifier}`);

        // 5. Get low nullifier membership witness at inclusion block
        const lowNullifierWitness = await this.config.node.getLowNullifierMembershipWitness(
            inclusionBlock,
            siloedNullifier,
        );
        if (!lowNullifierWitness) {
            throw new Error('Failed to get low nullifier witness');
        }

        console.log(`  Low nullifier index: ${lowNullifierWitness.index}`);
        console.log(`  Low nullifier value: ${lowNullifierWitness.leafPreimage.leaf.nullifier}`);
        console.log(`  Low nullifier next: ${lowNullifierWitness.leafPreimage.nextKey}`);

        // 6. Format circuit inputs
        const circuitInputs = {
            // Note data
            note_value: new Fr(noteData.value).toString(),
            owner: noteData.owner.toString(),
            storage_slot: noteData.storageSlot.toString(),
            randomness: noteData.randomness.toString(),
            note_nonce: noteData.noteNonce.toString(),
            contract_address: noteData.contractAddress.toString(),
            // Block references
            before_block_number: new Fr(BigInt(beforeBlock)).toString(),
            before_tree_size: new Fr(BigInt(beforeTreeSize)).toString(),
            inclusion_block_number: new Fr(BigInt(inclusionBlock)).toString(),
            // Note hash tree
            note_hash_tree_root: noteHashTreeRoot.toString(),
            // Note inclusion witness
            note_leaf_index: new Fr(noteWitness.leafIndex).toString(),
            note_sibling_path: noteWitness.siblingPath.map((f: Fr) => f.toString()),
            // Nullifier non-inclusion
            nsk_app: noteData.nskApp.toString(),
            nullifier_tree_root: nullifierTreeRoot.toString(),
            low_nullifier_preimage: {
                nullifier: lowNullifierWitness.leafPreimage.leaf.nullifier.toString(),
                next_nullifier: lowNullifierWitness.leafPreimage.nextKey.toString(),
                next_index: new Fr(BigInt(lowNullifierWitness.leafPreimage.nextIndex)).toString(),
            },
            low_nullifier_index: new Fr(BigInt(lowNullifierWitness.index)).toString(),
            low_nullifier_path: lowNullifierWitness.siblingPath.toFields().map((f: Fr) => f.toString()),
        };

        // 7. Generate witness and proof
        console.log('\n  Generating witness...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [value, provenBeforeBlock, provenInclusionBlock, provenContract, provenNoteRoot, provenNullifierRoot] =
            returnValue as [string, string, string, string, string, string];

        console.log(`  Proven value: ${BigInt(value)}`);
        console.log('  Generating proof...');

        const proof = await this.backend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
        const isValid = await this.backend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
        if (!isValid) {
            throw new Error('Note creation proof verification failed');
        }
        console.log('  Proof verified!');

        return {
            proof: proof.proof,
            publicInputs: {
                noteValue: BigInt(value),
                beforeBlockNumber: BigInt(provenBeforeBlock),
                inclusionBlockNumber: BigInt(provenInclusionBlock),
                contractAddress: provenContract,
                noteHashTreeRoot: provenNoteRoot,
                nullifierTreeRoot: provenNullifierRoot,
            },
        };
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing NoteCreationProver...');
        this.noir = new Noir(this.config.circuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(this.config.circuit.bytecode, this.config.bb);
        console.log('NoteCreationProver initialized');
    }
}
