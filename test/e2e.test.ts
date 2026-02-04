import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '../src/artifacts';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import { sleep } from "bun";
import { retrieveEncryptedNotes } from "../src/auditor";
import { decryptNote, parseNotePlaintext } from "../src/decrypt";
import { computeAddressSecret } from '@aztec/stdlib/keys';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { GeneratorIndex } from '@aztec/constants';

// Noir circuit imports
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';

// Import the compiled individual_note circuit
import individualNoteCircuit from '../circuits/individual_note/target/individual_note.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Private Transfer Demo Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token: TokenContract;

    // Circuit proving components
    let bb: Barretenberg;
    let noir: Noir;
    let backend: UltraHonkBackend;

    before(async () => {
        // Initialize Barretenberg and Noir circuit
        console.log("Initializing Barretenberg...");
        bb = await Barretenberg.new();
        console.log("Barretenberg initialized ✅");

        // Initialize Noir with the compiled circuit
        const circuit = individualNoteCircuit as CompiledCircuit;
        noir = new Noir(circuit);
        await noir.init();
        console.log("Noir circuit initialized ✅");

        // Create the proving backend
        backend = new UltraHonkBackend(circuit.bytecode, bb);
        console.log("UltraHonk backend initialized ✅");

        // setup aztec node client
        node = createAztecNodeClient(AZTEC_NODE_URL);
        console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

        // setup wallets
        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false })

        const accounts = await getInitialTestAccountsData();
        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }


        // deploy token contracts
        token = await TokenContract.deployWithOpts(
            { wallet, method: "constructor_with_minter" },
            "USD Coin",
            "USDC",
            18,
            addresses[0],
            AztecAddress.ZERO
        ).send({ from: addresses[0] }).deployed();

        // mint tokens
    
        await token.methods.mint_to_private(addresses[1], precision(100n)).send({ from: addresses[0]}).wait();
        await token.methods.mint_to_private(addresses[2], precision(100n)).send({ from: addresses[0]}).wait();
    });

    test("generate tx activity", async () => {
        // send tokens back and forth - 5 transfers in each direction
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(3n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(7n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(5n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(2n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(9n), 0).send({ from: addresses[1] }).wait();

        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(4n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(6n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(8n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(1n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(10n), 0).send({ from: addresses[2] }).wait();
    });

    test("get notes to prove", async () => {
        // Small wait to ensure everything is synced
        await sleep(3000);

        // Step 1: Export tagging secrets from wallet (user side)
        console.log("\n=== STEP 1: Exporting Tagging Secrets ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        console.log("Exported tagging secrets:", taggingSecrets.secrets.length, "secrets");

        // Debug: print the actual secrets
        for (const secret of taggingSecrets.secrets) {
            console.log(`  Secret: ${secret.direction} - counterparty: ${secret.counterparty.toString().slice(0, 16)}... app: ${secret.app.toString().slice(0, 16)}...`);
            console.log(`    Secret value: ${secret.secret.toString()}`);
        }

        // Step 2: Auditor retrieves encrypted notes using the secrets
        console.log("\n=== STEP 2: Retrieving Encrypted Notes ===");
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        // Step 3: Display results organized by secret
        console.log("\n=== RETRIEVAL RESULTS ===");
        console.log(`Account: ${results.account}`);
        console.log(`Total Notes: ${results.totalNotes}`);
        console.log(`Total Transactions: ${results.totalTransactions}`);
        console.log(`Secrets Processed: ${results.secrets.length}`);

        for (const secretResult of results.secrets) {
            console.log(`\n--- Secret: ${secretResult.secret.counterparty.slice(0, 16)}... (${secretResult.secret.direction}) ---`);
            console.log(`  App: ${secretResult.secret.app.slice(0, 16)}...`);
            console.log(`  Notes Found: ${secretResult.noteCount}`);

            // Show first 2 notes for this secret
            secretResult.notes.slice(0, 2).forEach((note, i) => {
                console.log(`\n  [${i + 1}] Note Hash: ${note.noteHash}`);
                console.log(`      Tx: ${note.txHash.slice(0, 16)}...`);
                console.log(`      Block: ${note.blockNumber}`);
                console.log(`      Ciphertext: ${note.ciphertextBytes} bytes`);
                console.log(`      Hex (first 64): ${note.ciphertext.slice(0, 64)}...`);
                console.log(`      Tag Index: ${note.tagIndex}`);
            });

            if (secretResult.noteCount > 2) {
                console.log(`  ... and ${secretResult.noteCount - 2} more notes`);
            }
        }

        // Verify we found notes
        expect(results.totalNotes).toBeGreaterThan(0);

        console.log("\n✓ Test complete - encrypted logs retrieved successfully!");
    });

    test("decrypt a note", async () => {
        // Small wait to ensure everything is synced
        await sleep(3000);

        // Step 1: Get encrypted notes from auditor
        console.log("\n=== STEP 1: Retrieving Encrypted Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        expect(results.totalNotes).toBeGreaterThan(0);
        console.log(`Found ${results.totalNotes} encrypted notes`);

        // Step 2: Get the first note to decrypt
        const firstNote = results.secrets[0]?.notes[0];
        if (!firstNote) {
            throw new Error("No notes found to decrypt");
        }

        console.log("\n=== STEP 2: Decrypting Note ===");
        console.log(`Note Hash: ${firstNote.noteHash}`);
        console.log(`Tx Hash: ${firstNote.txHash}`);
        console.log(`Ciphertext size: ${firstNote.ciphertextBytes} bytes`);

        // Step 3: Get recipient's keys
        // The recipient is addresses[1] (the account we exported secrets for)
        const pxe = wallet.pxe as any; // Cast to access internal methods
        const registeredAccounts = await pxe.getRegisteredAccounts();
        console.log("Registered accounts", registeredAccounts);
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );

        if (!recipientCompleteAddress) {
            throw new Error(`Account ${addresses[1].toString()} not found in PXE`);
        }

        // Get the master incoming viewing secret key
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);

        // Step 4: Decrypt the note
        const encryptedLogBuffer = Buffer.from(firstNote.ciphertext, 'hex');
        const plaintext = await decryptNote(
            encryptedLogBuffer,
            recipientCompleteAddress,
            ivskM
        );

        if (!plaintext) {
            throw new Error("Decryption failed");
        }

        console.log(`✓ Decryption successful! Got ${plaintext.length} fields`);

        // Step 5: Parse the plaintext
        const parsed = parseNotePlaintext(plaintext);
        if (!parsed) {
            throw new Error("Failed to parse plaintext");
        }

        // Extract the note value (for UintNote, the packed note is just the value)
        const value = parsed.packedNote.length > 0 ? parsed.packedNote[0].toBigInt() : 0n;
        const tokenAmount = value / precision(1n);

        console.log("\n=== DECRYPTED NOTE CONTENTS ===");
        console.log(`✓ NOTE VALUE: ${tokenAmount} tokens (${value} raw)`);
        console.log(`Message Type ID: ${parsed.msgTypeId}`);
        console.log(`Note Type ID: ${parsed.noteTypeId}`);
        console.log(`Owner: ${parsed.owner.toString()}`);
        console.log(`Storage Slot: ${parsed.storageSlot.toString()}`);
        console.log(`Randomness: ${parsed.randomness.toString()}`);
        console.log(`Packed Note Fields: ${parsed.packedNote.length}`);

        // Verify the owner matches
        expect(parsed.owner.equals(addresses[1]) || parsed.owner.equals(addresses[2])).toBe(true);

        console.log("\n✓ Test complete - note decrypted successfully!");
    });

    test("prove note with circuit", async () => {
        // Small wait to ensure everything is synced
        await sleep(3000);

        // Step 1: Get encrypted notes and decrypt one
        console.log("\n=== STEP 1: Getting Note Data ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        expect(results.totalNotes).toBeGreaterThan(0);
        const firstNote = results.secrets[0]?.notes[0];
        if (!firstNote) {
            throw new Error("No notes found");
        }

        // Get recipient's keys
        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);

        // Decrypt the note
        const encryptedLogBuffer = Buffer.from(firstNote.ciphertext, 'hex');
        const plaintext = await decryptNote(encryptedLogBuffer, recipientCompleteAddress, ivskM);
        if (!plaintext) {
            throw new Error("Decryption failed");
        }

        console.log(`Decrypted note with ${plaintext.length} fields`);

        // Step 2: Prepare circuit inputs
        console.log("\n=== STEP 2: Preparing Circuit Inputs ===");

        // Convert plaintext to circuit format (BoundedVec<Field, 14>)
        // BoundedVec requires a struct with 'storage' array and 'len'
        const plaintextStorage = plaintext.map(f => f.toString());
        const plaintextLen = plaintextStorage.length;

        // Pad storage to 14 fields
        while (plaintextStorage.length < 14) {
            plaintextStorage.push("0");
        }

        // Create BoundedVec structure
        const notePlaintext = {
            storage: plaintextStorage,
            len: plaintextLen.toString(),
        };

        // Parse ciphertext from hex to fields
        // The encrypted log structure is: [tag (32 bytes) | fields...]
        // Skip the tag (first 32 bytes) - the circuit expects ciphertext without tag
        const ciphertextWithoutTag = encryptedLogBuffer.slice(32);

        // The ciphertext is MESSAGE_CIPHERTEXT_LEN (17) fields, each stored as 32 bytes
        const MESSAGE_CIPHERTEXT_LEN = 17;
        const ciphertextFields: string[] = [];

        // Pad the buffer to ensure we have enough bytes for all fields
        const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
        ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

        for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
            const chunk = paddedBuffer.slice(i * 32, (i + 1) * 32);
            const field = Fr.fromBuffer(chunk);
            ciphertextFields.push(field.toString());
        }

        console.log(`Ciphertext buffer size: ${ciphertextWithoutTag.length} bytes`);
        console.log(`Expected size: ${MESSAGE_CIPHERTEXT_LEN * 32} bytes`);

        // Get note hash from the retrieved note
        const noteHash = firstNote.noteHash;

        // Compute the address secret (what's actually used for ECDH)
        // addressSecret = computeAddressSecret(preaddress, ivskM)
        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);
        const recipientIvskApp = addressSecret.toString();

        // Debug: print key values to compare with circuit
        console.log("\n=== DEBUG: Key Values ===");
        console.log(`preaddress: ${preaddress.toString()}`);
        console.log(`ivskM: ${ivskM.toString()}`);
        console.log(`addressSecret: ${addressSecret.toString()}`);
        console.log(`eph_pk.x (ciphertext[0]): ${ciphertextFields[0]}`);

        // Parse eph_pk sign from ciphertext
        // ciphertext[1..] contains message fields, which when unpacked give [sign_byte | header | body | padding]
        const firstMessageField = Fr.fromString(ciphertextFields[1]);
        const fieldBytes = firstMessageField.toBuffer();
        // Fields are packed with 31 bytes (skip high byte)
        const signByte = fieldBytes[1]; // First byte of the 31-byte content
        console.log(`eph_pk sign byte: ${signByte} (sign: ${signByte !== 0})`);

        // Get recipient address - AztecAddress is a struct with 'inner' field
        const recipientAddress = {
            inner: addresses[1].toString(),
        };

        // Get token contract address for siloed note hash
        const contractAddress = {
            inner: token.address.toString(),
        };

        const circuitInputs = {
            note_plaintext: notePlaintext,
            ciphertext: ciphertextFields,
            note_hash: noteHash,
            recipient_ivsk_app: recipientIvskApp,
            recipient_address: recipientAddress,
            contract_address: contractAddress,
        };

        console.log("Circuit inputs prepared:");
        console.log(`  - Plaintext fields: ${plaintextLen} (storage: ${plaintextStorage.length})`);
        console.log(`  - Ciphertext fields: ${ciphertextFields.length}`);
        console.log(`  - Note hash from auditor: ${noteHash}`);
        console.log(`  - Contract address: ${token.address.toString()}`);

        // Debug: print plaintext fields
        console.log("\n=== Plaintext Fields ===");
        for (let i = 0; i < plaintextLen; i++) {
            console.log(`  plaintext[${i}]: ${plaintext[i].toString()}`);
        }

        // Compute expected note hash in JS to compare
        const owner = plaintext[1];
        const storageSlot = plaintext[2];
        const randomness = plaintext[3];
        const value = plaintext[4];

        // Step 1: partial_commitment = poseidon2([owner, storage_slot, randomness], GENERATOR_INDEX__NOTE_HASH)
        const partialCommitment = await poseidon2HashWithSeparator(
            [owner, storageSlot, randomness],
            GeneratorIndex.NOTE_HASH
        );
        console.log(`\n=== JS Hash Computation ===`);
        console.log(`  partial_commitment: ${partialCommitment.toString()}`);

        // Step 2: inner_note_hash = poseidon2([partial_commitment, value], GENERATOR_INDEX__NOTE_HASH)
        const innerNoteHash = await poseidon2HashWithSeparator(
            [partialCommitment, value],
            GeneratorIndex.NOTE_HASH
        );
        console.log(`  inner_note_hash: ${innerNoteHash.toString()}`);

        // Step 3: siloed_note_hash = poseidon2([contract_address, inner_note_hash], GENERATOR_INDEX__SILOED_NOTE_HASH)
        const siloedNoteHash = await poseidon2HashWithSeparator(
            [token.address.toField(), innerNoteHash],
            GeneratorIndex.SILOED_NOTE_HASH
        );
        console.log(`  siloed_note_hash (computed): ${siloedNoteHash.toString()}`);
        console.log(`  note_hash (from auditor):   ${noteHash}`);

        // Step 3: Generate witness
        console.log("\n=== STEP 3: Generating Witness ===");
        const { witness, returnValue } = await noir.execute(circuitInputs);
        console.log(`Witness generated ✅`);
        console.log(`Return value: ${JSON.stringify(returnValue)}`);

        // Step 4: Generate proof
        console.log("\n=== STEP 4: Generating Proof ===");
        const proof = await backend.generateProof(witness);
        console.log(`Proof generated ✅`);
        console.log(`Proof size: ${proof.proof.length} bytes`);

        // Step 5: Verify proof
        console.log("\n=== STEP 5: Verifying Proof ===");
        const isValid = await backend.verifyProof(proof);
        console.log(`Proof verification: ${isValid ? '✅ VALID' : '❌ INVALID'}`);

        expect(isValid).toBe(true);
        console.log("\n✓ Test complete - note proven successfully!");
    });

});