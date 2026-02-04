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
import { retrieveEncryptedNotes, retrieveCiphertexts, type AuditorSecretInput } from "../src/auditor";
import { buildIMTFromCiphertexts, getZeroHashes } from "../src/imt";
import { ProofTree } from "../src/proof-tree";
import { decryptNote, parseNotePlaintext } from "../src/decrypt";
import { computeAddressSecret } from '@aztec/stdlib/keys';

// Noir circuit imports
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';

// Import the compiled circuits
import individualNoteCircuit from '../circuits/individual_note/target/individual_note.json' with { type: 'json' };
import summaryTreeCircuit from '../circuits/note_summary_tree/target/note_summary_tree.json' with { type: 'json' };

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
        // await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(3n), 0).send({ from: addresses[1] }).wait();
        // await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(7n), 0).send({ from: addresses[1] }).wait();
        // await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(5n), 0).send({ from: addresses[1] }).wait();
        // await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(2n), 0).send({ from: addresses[1] }).wait();
        // await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(9n), 0).send({ from: addresses[1] }).wait();

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
            console.log(`  Secret: counterparty: ${secret.counterparty.toString().slice(0, 16)}... app: ${secret.app.toString().slice(0, 16)}...`);
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
            console.log(`\n--- Secret: ${secretResult.secret.counterparty.slice(0, 16)}... ---`);
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

    test.skip("decrypt a note", async () => {
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

    test.skip("prove note with circuit", async () => {
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

        const circuitInputs = {
            plaintext: notePlaintext,
            ciphertext: ciphertextFields,
            ivsk_app: recipientIvskApp,
        };

        console.log("Circuit inputs prepared:");
        console.log(`  - Plaintext fields: ${plaintextLen} (storage: ${plaintextStorage.length})`);
        console.log(`  - Ciphertext fields: ${ciphertextFields.length}`);

        // Debug: print plaintext fields
        console.log("\n=== Plaintext Fields ===");
        for (let i = 0; i < plaintextLen; i++) {
            console.log(`  plaintext[${i}]: ${plaintext[i].toString()}`);
        }

        // Expected values from plaintext
        const expectedValue = plaintext[4].toString();

        // Step 3: Generate witness (3 return values now: value, tree_leaf, vkey_hash)
        console.log("\n=== STEP 3: Generating Witness ===");
        const { witness, returnValue } = await noir.execute(circuitInputs);
        console.log(`Witness generated ✅`);
        console.log(`Return value: ${JSON.stringify(returnValue)}`);

        // Verify returned values
        const [circuitValue, circuitTreeLeaf, circuitVkeyHash] = returnValue as [string, string, string];
        console.log(`\n=== Verifying Circuit Output ===`);
        console.log(`  Expected value: ${expectedValue}`);
        console.log(`  Circuit value:  ${circuitValue}`);
        console.log(`  Vkey hash:      ${circuitVkeyHash} (should be 0 for leaf proofs)`);
        // Compare as BigInt since formatting may differ (leading zeros)
        expect(BigInt(circuitValue)).toBe(BigInt(expectedValue));
        console.log(`  ✅ Value matches! (${BigInt(circuitValue) / precision(1n)} tokens)`);

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

    test.skip("retrieve ciphertexts with minimal API", async () => {
        await sleep(3000);

        // Step 1: Export tagging secrets (client side - knows full metadata)
        console.log("\n=== STEP 1: Client Exports Tagging Secrets ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        console.log(`Exported ${taggingSecrets.secrets.length} secrets`);

        // Step 2: Client extracts minimal info to send to auditor (INBOUND ONLY)
        // Only secretValue and appAddress - NO direction, counterparty, label
        // Client filters to inbound since only inbound notes are decryptable
        console.log("\n=== STEP 2: Extract Minimal Info for Auditor (Inbound Only) ===");
        const inboundSecrets = taggingSecrets.secrets.filter(s => s.direction === 'inbound');
        const minimalSecrets: AuditorSecretInput[] = inboundSecrets.map(s => ({
            secretValue: s.secret.value,
            appAddress: s.app,
        }));
        console.log(`Prepared ${minimalSecrets.length} minimal secrets (inbound only, no metadata)`);

        // Step 3: Auditor retrieves ciphertexts + IMT root
        console.log("\n=== STEP 3: Auditor Retrieves Ciphertexts ===");
        const results = await retrieveCiphertexts(node, minimalSecrets);

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            console.log(`\nSecret ${i + 1}:`);
            console.log(`  Ciphertexts found: ${result.ciphertexts.length}`);
            console.log(`  IMT Root: ${result.imtRoot.toString()}`);
            if (result.ciphertexts.length > 0) {
                console.log(`  First ciphertext size: ${result.ciphertexts[0].length} bytes`);
            }
        }

        // Step 4: Client can rebuild IMT to verify
        console.log("\n=== STEP 4: Client Rebuilds IMT to Verify ===");
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.ciphertexts.length > 0) {
                const clientRoot = await buildIMTFromCiphertexts(result.ciphertexts);
                const matches = clientRoot.equals(result.imtRoot);
                console.log(`Secret ${i + 1}: Client IMT root ${matches ? '✅ MATCHES' : '❌ MISMATCH'}`);
                expect(matches).toBe(true);
            }
        }

        // Verify we found ciphertexts
        const totalCiphertexts = results.reduce((sum, r) => sum + r.ciphertexts.length, 0);
        console.log(`\nTotal ciphertexts: ${totalCiphertexts}`);
        expect(totalCiphertexts).toBeGreaterThan(0);

        console.log("\n✓ Test complete - minimal API works!");
    });

    test.skip("prove all notes for recursive aggregation", async () => {
        await sleep(3000);

        // ============================================================
        // STEP 1: Get encrypted notes (auditor filters to inbound only)
        // ============================================================
        console.log("\n=== STEP 1: Getting Inbound Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        // Get recipient's keys for decryption
        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);
        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);

        // Collect all notes (auditor returns only inbound/decryptable notes)
        const allNotes = results.secrets.flatMap(s => s.notes);
        console.log(`Total inbound notes: ${allNotes.length}`);

        // ============================================================
        // STEP 2: Prove all notes
        // ============================================================
        console.log("\n=== STEP 2: Proving All Notes ===");

        interface ProofData {
            proof: Uint8Array;
            publicInputs: string[];
            value: bigint;
            treeLeaf: string;
        }

        const proofs: ProofData[] = [];

        for (let i = 0; i < allNotes.length; i++) {
            const note = allNotes[i];
            console.log(`\n--- Proving note ${i + 1}/${allNotes.length} ---`);

            // Decrypt
            const encryptedLogBuffer = Buffer.from(note.ciphertext, 'hex');
            const plaintext = await decryptNote(encryptedLogBuffer, recipientCompleteAddress, ivskM);
            if (!plaintext) {
                throw new Error(`Failed to decrypt note ${i}`);
            }

            // Prepare circuit inputs
            const circuitInputs = prepareCircuitInputs(plaintext, encryptedLogBuffer, addressSecret);

            // Generate witness and proof (3 return values now: value, tree_leaf, vkey_hash)
            const { witness, returnValue } = await noir.execute(circuitInputs);
            const [circuitValue, circuitTreeLeaf, circuitVkeyHash] = returnValue as [string, string, string];

            const proof = await backend.generateProof(witness);
            const isValid = await backend.verifyProof(proof);

            if (!isValid) {
                throw new Error(`Invalid proof for note ${i}`);
            }

            const value = BigInt(circuitValue);
            console.log(`  Value: ${value / precision(1n)} tokens`);
            console.log(`  Tree Leaf: ${circuitTreeLeaf.slice(0, 20)}...`);
            console.log(`  Proof: ✅ Valid (${proof.proof.length} bytes)`);

            proofs.push({
                proof: proof.proof,
                publicInputs: [circuitValue, circuitTreeLeaf, circuitVkeyHash],
                value,
                treeLeaf: circuitTreeLeaf,
            });
        }

        // ============================================================
        // STEP 3: Summarize results for recursive circuit
        // ============================================================
        console.log("\n=== STEP 3: Summary for Recursive Aggregation ===");

        const total = proofs.reduce((sum, p) => sum + p.value, 0n);

        console.log(`\nNotes proven: ${proofs.length}`);
        console.log(`Total value: ${total / precision(1n)} tokens`);
        proofs.forEach((p, i) => console.log(`  [${i}] ${p.value / precision(1n)} tokens`));

        // Get verification key for recursive verification
        const vk = await backend.getVerificationKey();
        console.log(`\nVerification Key: ${vk.length} bytes`);

        // ============================================================
        // STEP 4: Prepare recursive circuit inputs
        // ============================================================
        console.log("\n=== STEP 4: Recursive Circuit Input Structure ===");

        // This is the data structure the recursive circuit needs:
        const recursiveInputs = {
            // Verification key (shared by all proofs from same circuit)
            verification_key: Array.from(vk),

            // All proofs
            proofs: proofs.map(p => ({
                proof: Array.from(p.proof),
                public_inputs: p.publicInputs,
            })),

            // Expected total (for circuit assertion)
            expected_total: total.toString(),
        };

        console.log(`Recursive inputs prepared:`);
        console.log(`  - VK size: ${recursiveInputs.verification_key.length} bytes`);
        console.log(`  - Proofs: ${recursiveInputs.proofs.length}`);
        console.log(`  - Proof sizes: ${proofs[0]?.proof.length || 0} bytes each`);

        console.log("\n✓ Proofs generated for recursive aggregation!");

        expect(proofs.length).toBe(5);
        console.log(`\nFinal count: ${proofs.length} proofs`);
    });

    test.skip("recursive summary proof", async () => {
        await sleep(3000);

        // ============================================================
        // STEP 1: Get encrypted notes (only use first 2 for speed)
        // ============================================================
        console.log("\n=== STEP 1: Getting First 2 Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);
        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);

        // Only take first 2 notes
        const allNotes = results.secrets.flatMap(s => s.notes).slice(0, 2);
        console.log(`Using ${allNotes.length} notes for recursive test`);

        // ============================================================
        // STEP 2: Generate 2 proofs from individual_note circuit
        // ============================================================
        console.log("\n=== STEP 2: Generating 2 Inner Proofs ===");

        interface ProofArtifacts {
            proof: Uint8Array;
            proofAsFields: string[];
            publicInputs: string[];
            value: bigint;
        }

        const proofArtifacts: ProofArtifacts[] = [];

        for (let i = 0; i < allNotes.length; i++) {
            const note = allNotes[i];
            console.log(`\n--- Proving note ${i + 1}/${allNotes.length} ---`);

            const encryptedLogBuffer = Buffer.from(note.ciphertext, 'hex');
            const plaintext = await decryptNote(encryptedLogBuffer, recipientCompleteAddress, ivskM);
            if (!plaintext) throw new Error(`Failed to decrypt note ${i}`);

            const circuitInputs = prepareCircuitInputs(plaintext, encryptedLogBuffer, addressSecret);
            const { witness, returnValue } = await noir.execute(circuitInputs);
            const [circuitValue, circuitTreeLeaf] = returnValue as [string, string];

            // Generate ZK proof with recursive target for use in recursive verification
            const proof = await backend.generateProof(witness, { verifierTarget: 'noir-recursive' });
            const isValid = await backend.verifyProof(proof, { verifierTarget: 'noir-recursive' });
            if (!isValid) throw new Error(`Invalid proof for note ${i}`);

            // Get recursive proof artifacts (3 public inputs: value, tree_leaf, vkey_hash)
            const artifacts = await backend.generateRecursiveProofArtifacts(proof.proof, 3);

            // Manually convert proof bytes to fields (32 bytes per field)
            const proofAsFields: string[] = [];
            for (let j = 0; j < proof.proof.length; j += 32) {
                const chunk = proof.proof.slice(j, j + 32);
                const hex = '0x' + Buffer.from(chunk).toString('hex');
                proofAsFields.push(hex);
            }

            console.log(`  Value: ${BigInt(circuitValue) / precision(1n)} tokens`);
            console.log(`  Proof: ✅ Valid`);
            console.log(`  proof.proof length: ${proof.proof.length} bytes`);
            console.log(`  proofAsFields (manual): ${proofAsFields.length} fields`);
            console.log(`  vkAsFields: ${artifacts.vkAsFields.length} fields`);
            console.log(`  vkHash (FULL - for hardcoding): ${artifacts.vkHash}`);

            // Extract 3rd return value (vkey_hash = 0 for leaf proofs)
            const [, , circuitVkeyHash] = returnValue as [string, string, string];

            proofArtifacts.push({
                proof: proof.proof,
                proofAsFields: proofAsFields,
                publicInputs: [circuitValue, circuitTreeLeaf, circuitVkeyHash],
                value: BigInt(circuitValue),
            });
        }

        // Get vk artifacts (same for all proofs from same circuit) - 3 public inputs now
        const vkArtifacts = await backend.generateRecursiveProofArtifacts(proofArtifacts[0].proof, 3);

        // ============================================================
        // STEP 3: Setup summary circuit
        // ============================================================
        console.log("\n=== STEP 3: Setting up Summary Circuit ===");

        const summaryCircuit = summaryTreeCircuit as CompiledCircuit;
        const summaryNoir = new Noir(summaryCircuit);
        await summaryNoir.init();
        const summaryBackend = new UltraHonkBackend(summaryCircuit.bytecode, bb);
        console.log("Summary circuit initialized ✅");

        // ============================================================
        // STEP 4: Prepare inputs for summary circuit
        // ============================================================
        console.log("\n=== STEP 4: Preparing Summary Circuit Inputs ===");

        // Get zero hashes for padding (when we have odd number of notes)
        const zeroHashes = await getZeroHashes(10);
        const hasRightProof = proofArtifacts.length > 1;

        // Create empty proof for Option::none() case - 3 public inputs now
        const emptyProof = new Array(proofArtifacts[0].proofAsFields.length).fill("0x0");
        const emptyPublicInputs = ["0x0", "0x0", "0x0"];

        const summaryInputs = {
            verification_key: vkArtifacts.vkAsFields,
            vkey_hash: vkArtifacts.vkHash,
            proof_left: proofArtifacts[0].proofAsFields,
            proof_right: {
                _is_some: hasRightProof,
                _value: hasRightProof ? proofArtifacts[1].proofAsFields : emptyProof,
            },
            public_inputs_left: proofArtifacts[0].publicInputs,
            public_inputs_right: {
                _is_some: hasRightProof,
                _value: hasRightProof ? proofArtifacts[1].publicInputs : emptyPublicInputs,
            },
            zero_leaf_hint: {
                _is_some: !hasRightProof,
                _value: hasRightProof ? "0x0" : zeroHashes[0].toString(),
            },
            // At level 0, summary_vkey_hash is just passed through (not checked)
            // We use a placeholder here since this test only does one level
            summary_vkey_hash: "0x0",
        };

        console.log(`  vk fields: ${summaryInputs.verification_key.length}`);
        console.log(`  vk hash: ${summaryInputs.vkey_hash}`);
        console.log(`  proof_left fields: ${summaryInputs.proof_left.length}`);
        console.log(`  proof_right._is_some: ${summaryInputs.proof_right._is_some}`);
        console.log(`  public_inputs_left: ${summaryInputs.public_inputs_left}`);
        console.log(`  public_inputs_right._is_some: ${summaryInputs.public_inputs_right._is_some}`);
        console.log(`  zero_leaf_hint._is_some: ${summaryInputs.zero_leaf_hint._is_some}`);

        // ============================================================
        // STEP 5: Execute summary circuit
        // ============================================================
        console.log("\n=== STEP 5: Executing Summary Circuit ===");

        const { witness: summaryWitness, returnValue: summaryReturn } = await summaryNoir.execute(summaryInputs);
        const [returnSum, returnRoot, returnVkeyHash] = summaryReturn as [string, string, string];
        console.log(`Summary witness generated ✅`);
        console.log(`Return value (sum): ${returnSum}`);
        console.log(`Return value (root): ${returnRoot}`);
        console.log(`Return value (vkey_hash): ${returnVkeyHash}`);

        const expectedSum = proofArtifacts[0].value + (hasRightProof ? proofArtifacts[1].value : 0n);
        console.log(`Expected sum: ${expectedSum}`);
        expect(BigInt(returnSum)).toBe(expectedSum);

        // ============================================================
        // STEP 6: Generate and verify summary proof
        // ============================================================
        console.log("\n=== STEP 6: Generating Summary Proof ===");

        const summaryProof = await summaryBackend.generateProof(summaryWitness);
        console.log(`Summary proof generated ✅ (${summaryProof.proof.length} bytes)`);

        const summaryValid = await summaryBackend.verifyProof(summaryProof);
        console.log(`Summary proof verification: ${summaryValid ? '✅ VALID' : '❌ INVALID'}`);

        expect(summaryValid).toBe(true);
        console.log(`\n✓ Recursive summary proof complete!`);
        console.log(`  Sum: ${expectedSum / precision(1n)} tokens`);
        console.log(`  Root: ${returnRoot}`);
    });

    test("proof tree full aggregation", { timeout: 300000 }, async () => {
        await sleep(3000);

        // ============================================================
        // STEP 1: Get all encrypted notes
        // ============================================================
        console.log("\n=== STEP 1: Getting All Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);

        const allNotes = results.secrets.flatMap(s => s.notes);
        console.log(`Found ${allNotes.length} notes to prove`);

        // ============================================================
        // STEP 2: Create ProofTree and prove all notes
        // ============================================================
        console.log("\n=== STEP 2: Creating ProofTree ===");

        const tree = new ProofTree({
            bb,
            noteCircuit: individualNoteCircuit as CompiledCircuit,
            summaryCircuit: summaryTreeCircuit as CompiledCircuit,
            notes: allNotes.map(n => ({ ciphertext: Buffer.from(n.ciphertext, 'hex') })),
            recipientCompleteAddress,
            ivskM,
        });

        // ============================================================
        // STEP 3: Generate aggregated proof
        // ============================================================
        console.log("\n=== STEP 3: Generating Aggregated Proof ===");

        const result = await tree.prove();

        console.log(`\n=== FINAL RESULT ===`);
        console.log(`  Sum: ${result.publicInputs.sum / precision(1n)} tokens (${result.publicInputs.sum} raw)`);
        console.log(`  Root: ${result.publicInputs.root}`);
        console.log(`  VKey Hash: ${result.publicInputs.vkeyHash}`);
        console.log(`  Proof size: ${result.proof.length} bytes`);

        // Verify the sum matches expected
        // Notes are: 4, 6, 8, 1, 10 = 29 tokens
        const expectedSum = 29n * precision(1n);
        expect(result.publicInputs.sum).toBe(expectedSum);

        // Verify the merkle root matches the IMT root computed by auditor
        const ciphertexts = allNotes.map(n => Buffer.from(n.ciphertext, 'hex'));
        const expectedRoot = await buildIMTFromCiphertexts(ciphertexts);
        expect(result.publicInputs.root).toBe(expectedRoot.toString());
        console.log(`  Merkle root matches auditor IMT: ✅`);

        console.log(`\n✓ ProofTree aggregation complete!`);
    });

});

// Helper function to prepare circuit inputs from decrypted plaintext
function prepareCircuitInputs(
    plaintext: Fr[],
    encryptedLogBuffer: Buffer,
    addressSecret: any
): { plaintext: { storage: string[]; len: string }; ciphertext: string[]; ivsk_app: string } {
    // Convert plaintext to circuit format (BoundedVec<Field, 14>)
    const plaintextStorage = plaintext.map(f => f.toString());
    const plaintextLen = plaintextStorage.length;

    // Pad storage to 14 fields
    while (plaintextStorage.length < 14) {
        plaintextStorage.push("0");
    }

    const notePlaintext = {
        storage: plaintextStorage,
        len: plaintextLen.toString(),
    };

    // Parse ciphertext from hex to fields
    // Skip the tag (first 32 bytes)
    const ciphertextWithoutTag = encryptedLogBuffer.slice(32);

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

    return {
        plaintext: notePlaintext,
        ciphertext: ciphertextFields,
        ivsk_app: addressSecret.toString(),
    };
}