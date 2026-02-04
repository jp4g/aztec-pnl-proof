import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { TagGenerator, NoteMapper, type TaggingSecretExport, type TaggingSecretEntry } from "@aztec/note-collector";
import { createLogger } from "@aztec/foundation/log";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { Fr } from "@aztec/foundation/curves/bn254";
import { buildIMTFromCiphertexts } from "./imt";

/**
 * Retrieve encrypted note ciphertexts from the Aztec network using tagging secrets.
 *
 * Takes a tagging secret export and returns all discovered notes organized by
 * which specific secret found them.
 *
 * @param node - Aztec node client
 * @param secretsExport - Exported tagging secrets from a user
 * @param options - Scan options
 * @returns Results organized by tagging secret
 */
export async function retrieveEncryptedNotes(
    node: AztecNode,
    secretsExport: TaggingSecretExport,
    options?: {
        startIndex?: number;
        maxIndices?: number;
        batchSize?: number;
    }
): Promise<RetrievalResult> {
    const startIndex = options?.startIndex ?? 0;
    const maxIndices = options?.maxIndices ?? 10000;
    const batchSize = options?.batchSize ?? 100;

    const log = createLogger('auditor');
    const noteMapper = new NoteMapper(node, log);

    const results: SecretResult[] = [];
    const allTransactions = new Set<string>();

    // Process each secret independently
    for (const secretEntry of secretsExport.secrets) {
        const secretResult = await processSecret(
            node,
            secretEntry,
            noteMapper,
            startIndex,
            maxIndices,
            batchSize
        );

        results.push(secretResult);

        // Track unique transactions
        secretResult.notes.forEach(note => allTransactions.add(note.txHash));
    }

    return {
        account: secretsExport.account.toString(),
        retrievedAt: Date.now(),
        secrets: results,
        totalNotes: results.reduce((sum, r) => sum + r.notes.length, 0),
        totalTransactions: allTransactions.size,
    };
}

/**
 * Process a single tagging secret and retrieve all matching notes.
 */
async function processSecret(
    node: AztecNode,
    secretEntry: TaggingSecretEntry,
    noteMapper: NoteMapper,
    startIndex: number,
    maxIndices: number,
    batchSize: number
): Promise<SecretResult> {
    const notes: RetrievedNote[] = [];

    console.log(`[DEBUG] Processing secret: ${secretEntry.direction} - counterparty: ${secretEntry.counterparty.toString().slice(0, 16)}...`);

    // Scan in batches
    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
        const count = Math.min(batchSize, startIndex + maxIndices - index);

        // Generate siloed tags for this batch (TWO-STEP PROCESS)
        // Step 1: Generate base tags (unsiloed)
        const baseTags = await TagGenerator.generateTags(secretEntry.secret, index, count);

        // Step 2: Silo each tag with the contract address
        // Formula: siloedTag = poseidon2Hash([contractAddress, baseTag])
        // This matches what the PXE does: SiloedTag.compute(Tag.compute(preTag), contractAddress)
        const siloedTags = await Promise.all(
            baseTags.map(async baseTag => {
                return await poseidon2Hash([secretEntry.app, baseTag]);
            })
        );

        console.log(`[DEBUG] Generated ${siloedTags.length} siloed tags for indices ${index}-${index + count - 1}`);
        console.log(`[DEBUG] First siloed tag: ${siloedTags[0].toString()}`);

        // Query logs by siloed tags
        const logsPerTag = await node.getLogsByTags(siloedTags);

        const totalLogs = logsPerTag.reduce((sum, logs) => sum + logs.length, 0);
        console.log(`[DEBUG] Received ${totalLogs} logs from node`);

        // Process each tag's logs
        for (let i = 0; i < logsPerTag.length; i++) {
            const logs = logsPerTag[i];
            if (logs.length === 0) continue;

            // Map logs to note hashes
            const mappings = await noteMapper.mapLogsToNoteHashes(
                logs,
                secretEntry.direction,
                secretEntry.counterparty,
                secretEntry.app
            );

            // Convert to retrieval format
            for (const mapping of mappings) {
                notes.push({
                    txHash: mapping.txHash.toString(),
                    blockNumber: mapping.blockNumber.toString(),
                    noteHash: mapping.noteHash.toString(),
                    ciphertext: mapping.encryptedLog.toString('hex'),
                    ciphertextBytes: mapping.encryptedLog.length,
                    logIndex: mapping.logIndexInTx,
                    treeIndex: mapping.dataStartIndexForTx,
                    tagIndex: index + i,
                });
            }
        }

        // If we found no logs in this batch, we might be done
        if (logsPerTag.every(logs => logs.length === 0)) {
            break;
        }
    }

    return {
        secret: {
            counterparty: secretEntry.counterparty.toString(),
            app: secretEntry.app.toString(),
            direction: secretEntry.direction,
            label: secretEntry.label,
        },
        notes,
        noteCount: notes.length,
    };
}

/**
 * Result of retrieving encrypted notes.
 */
export interface RetrievalResult {
    /** Account these notes belong to */
    account: string;
    /** When the retrieval was performed */
    retrievedAt: number;
    /** Results organized by tagging secret */
    secrets: SecretResult[];
    /** Total number of notes found across all secrets */
    totalNotes: number;
    /** Total number of unique transactions */
    totalTransactions: number;
}

/**
 * Notes retrieved using a specific tagging secret.
 */
export interface SecretResult {
    /** Metadata about the tagging secret */
    secret: {
        counterparty: string;
        app: string;
        direction: 'inbound' | 'outbound';
        label?: string;
    };
    /** All notes found with this secret */
    notes: RetrievedNote[];
    /** Number of notes found */
    noteCount: number;
}

/**
 * A single retrieved note with its encrypted ciphertext.
 */
export interface RetrievedNote {
    /** Transaction hash containing this note */
    txHash: string;
    /** Block number */
    blockNumber: string;
    /** Note hash (public commitment) */
    noteHash: string;
    /** Encrypted log ciphertext (hex encoded) */
    ciphertext: string;
    /** Size of ciphertext in bytes */
    ciphertextBytes: number;
    /** Index of this log within the transaction */
    logIndex: number;
    /** Starting index in the note hash tree */
    treeIndex: number;
    /** Tag index that discovered this note */
    tagIndex: number;
}

/**
 * Example usage:
 *
 * ```typescript
 * import { createAztecNodeClient } from "@aztec/aztec.js/node";
 * import { retrieveEncryptedNotes } from "./auditor";
 *
 * const node = createAztecNodeClient("http://localhost:8080");
 * const secretsExport = // ... load from file or wallet.exportTaggingSecrets()
 *
 * const results = await retrieveEncryptedNotes(node, secretsExport);
 *
 * // Organized by secret
 * for (const secretResult of results.secrets) {
 *   console.log(`Secret: ${secretResult.secret.counterparty} (${secretResult.secret.direction})`);
 *   console.log(`Found ${secretResult.noteCount} notes`);
 *
 *   for (const note of secretResult.notes) {
 *     console.log(`  Note: ${note.noteHash}`);
 *     console.log(`  Ciphertext: ${note.ciphertext.slice(0, 64)}...`);
 *   }
 * }
 * ```
 */

// =============================================================================
// NEW PRIVACY-PRESERVING API
// =============================================================================

/**
 * Minimal input for auditor - no metadata leaked.
 */
export interface AuditorSecretInput {
    /** Raw tagging secret value */
    secretValue: Fr;
    /** Contract address for tag siloing */
    appAddress: AztecAddress;
}

/**
 * Output from auditor - only ciphertexts and IMT root.
 */
export interface AuditorSecretOutput {
    /** Ciphertexts ordered from oldest to newest (by tag index) */
    ciphertexts: Buffer[];
    /** Root of incremental merkle tree of hashed ciphertexts */
    imtRoot: Fr;
}

/**
 * Retrieve ciphertexts from the Aztec network using minimal tagging secret info.
 *
 * Privacy-preserving: auditor receives no metadata about direction, counterparty, etc.
 *
 * @param node - Aztec node client
 * @param secrets - Array of (secretValue, appAddress) pairs
 * @param options - Scan options
 * @returns Array of outputs, one per input secret (preserves order)
 */
export async function retrieveCiphertexts(
    node: AztecNode,
    secrets: AuditorSecretInput[],
    options?: {
        maxIndices?: number;
        batchSize?: number;
    }
): Promise<AuditorSecretOutput[]> {
    const maxIndices = options?.maxIndices ?? 10000;
    const batchSize = options?.batchSize ?? 100;

    const results: AuditorSecretOutput[] = [];

    for (const secret of secrets) {
        const output = await processMinimalSecret(
            node,
            secret,
            maxIndices,
            batchSize
        );
        results.push(output);
    }

    return results;
}

/**
 * Process a single minimal secret - retrieve ciphertexts and build IMT.
 */
async function processMinimalSecret(
    node: AztecNode,
    secret: AuditorSecretInput,
    maxIndices: number,
    batchSize: number
): Promise<AuditorSecretOutput> {
    const ciphertexts: Buffer[] = [];

    // Scan from index 0 in batches
    for (let index = 0; index < maxIndices; index += batchSize) {
        const count = Math.min(batchSize, maxIndices - index);

        // Generate base tags: poseidon2([secretValue, index])
        const baseTags: Fr[] = [];
        for (let i = 0; i < count; i++) {
            const tag = await poseidon2Hash([secret.secretValue, new Fr(index + i)]);
            baseTags.push(tag);
        }

        // Silo tags with app address: poseidon2([appAddress, baseTag])
        const siloedTags = await Promise.all(
            baseTags.map(async baseTag => {
                return await poseidon2Hash([secret.appAddress.toField(), baseTag]);
            })
        );

        // Query logs by siloed tags
        const logsPerTag = await node.getLogsByTags(siloedTags);

        // Extract ciphertexts in order (by tag index)
        for (let i = 0; i < logsPerTag.length; i++) {
            const logs = logsPerTag[i];
            for (const log of logs) {
                // Extract the encrypted log data as Buffer
                const ciphertext = log.log.toBuffer();
                ciphertexts.push(ciphertext);
            }
        }

        // If we found no logs in this batch, we're done
        if (logsPerTag.every(logs => logs.length === 0)) {
            break;
        }
    }

    // Build IMT from ciphertexts
    const imtRoot = await buildIMTFromCiphertexts(ciphertexts);

    return {
        ciphertexts,
        imtRoot,
    };
}
