import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import { Barretenberg } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { NoteCreationProver } from '../src/note-creation';
import { Fr } from '@aztec/foundation/curves/bn254';
import { deriveKeys, computeAppNullifierSecretKey } from '@aztec/stdlib/keys';

import noteCreationCircuit from '../circuits/note_creation/target/note_creation.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Note Creation Proof Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token: TokenContract;
    let bb: Barretenberg;
    let accountSecretKey: Fr;

    const MINT_AMOUNT = precision(100n);

    before(async () => {
        console.log("Initializing Barretenberg...");
        const threads = require('os').cpus().length;
        bb = await Barretenberg.new({ threads });
        console.log("Barretenberg initialized");

        node = createAztecNodeClient(AZTEC_NODE_URL);
        console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false });

        const accounts = await getInitialTestAccountsData();
        // Store the secret key for the recipient (addresses[1]) so we can derive nsk_app
        accountSecretKey = accounts[1].secret;

        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }

        // Deploy Token contract
        console.log("Deploying Token...");
        token = await TokenContract.deploy(
            wallet,
            addresses[0], // admin
            "Test Token",
            "TST",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  Token: ${token.address}`);

        // Record the block before the mint
        console.log("Recording before-block...");
    });

    test("prove note creation", { timeout: 300000 }, async () => {
        // Record block number before minting
        const beforeBlock = await node.getBlockNumber();
        console.log(`\nBefore block: ${beforeBlock}`);

        // Mint to private - creates a UintNote for addresses[1]
        console.log("Minting to private...");
        await token.methods.mint_to_private(addresses[1], MINT_AMOUNT)
            .send({ from: addresses[0] }).wait();

        const inclusionBlock = await node.getBlockNumber();
        console.log(`Inclusion block: ${inclusionBlock}`);

        // Retrieve the note from PXE
        console.log("Retrieving note from PXE...");
        const pxe = wallet.pxe as any;
        const notes = await pxe.getNotes({
            contractAddress: token.address,
            owner: addresses[1],
        });

        expect(notes.length).toBeGreaterThan(0);
        // Use the most recently created note (last one)
        const noteDao = notes[notes.length - 1];
        console.log(`  Note value (raw): ${noteDao.note.items[0]}`);
        console.log(`  Note owner: ${noteDao.owner}`);
        console.log(`  Note storage slot: ${noteDao.storageSlot}`);
        console.log(`  Note randomness: ${noteDao.randomness}`);
        console.log(`  Note nonce: ${noteDao.noteNonce}`);
        console.log(`  Note leaf index: ${noteDao.index}`);

        // Derive nsk_app for the recipient
        console.log("Deriving nsk_app...");
        const keys = await deriveKeys(accountSecretKey);
        const nskApp = await computeAppNullifierSecretKey(
            keys.masterNullifierSecretKey,
            token.address,
        );
        console.log(`  nsk_app: ${nskApp}`);

        // Create prover and generate proof
        const prover = new NoteCreationProver({
            bb,
            circuit: noteCreationCircuit as CompiledCircuit,
            node,
        });

        const result = await prover.prove(
            {
                value: noteDao.note.items[0].toBigInt(),
                owner: noteDao.owner.toField(),
                storageSlot: noteDao.storageSlot,
                randomness: noteDao.randomness,
                noteNonce: noteDao.noteNonce,
                contractAddress: token.address.toField(),
                nskApp,
            },
            beforeBlock,
            inclusionBlock,
        );

        console.log(`\n=== NOTE CREATION PROOF RESULT ===`);
        console.log(`  Value: ${result.publicInputs.noteValue}`);
        console.log(`  Before block: ${result.publicInputs.beforeBlockNumber}`);
        console.log(`  Inclusion block: ${result.publicInputs.inclusionBlockNumber}`);
        console.log(`  Contract: ${result.publicInputs.contractAddress}`);
        console.log(`  Note hash root: ${result.publicInputs.noteHashTreeRoot}`);
        console.log(`  Nullifier root: ${result.publicInputs.nullifierTreeRoot}`);
        console.log(`  Proof size: ${result.proof.length} bytes`);

        // Verify the proven value matches what we minted
        expect(result.publicInputs.noteValue).toBe(MINT_AMOUNT);
        console.log(`\n  Expected value: ${MINT_AMOUNT}`);
        console.log(`  Proven value:   ${result.publicInputs.noteValue}`);
        console.log(`  Match: ${result.publicInputs.noteValue === MINT_AMOUNT}`);
    });

});
