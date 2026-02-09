import type { AztecNode } from "@aztec/aztec.js/node";
import { TagGenerator, type TaggingSecretExport, type TaggingSecretEntry } from "@aztec/note-collector";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

/**
 * Scan for encrypted event logs using tagging secrets.
 *
 * Adapted from the old auditor.ts. Key differences from note scanning:
 * - Events don't map to note hashes, so no NoteMapper is needed
 * - Returns raw encrypted log buffers (ciphertexts) for circuit proving
 * - Only processes INBOUND secrets (events encrypted for the account holder)
 *
 * @param node - Aztec node client
 * @param secretsExport - Exported tagging secrets from a user
 * @param options - Scan options
 * @returns Retrieved encrypted event logs
 */
export async function retrieveEncryptedEvents(
    node: AztecNode,
    secretsExport: TaggingSecretExport,
    options?: {
        startIndex?: number;
        maxIndices?: number;
        batchSize?: number;
    }
): Promise<EventRetrievalResult> {
    const startIndex = options?.startIndex ?? 0;
    const maxIndices = options?.maxIndices ?? 10000;
    const batchSize = options?.batchSize ?? 100;

    const results: EventSecretResult[] = [];

    // Filter to only inbound secrets - we can only decrypt events encrypted for us
    const inboundSecrets = secretsExport.secrets.filter(s => s.direction === 'inbound');

    for (const secretEntry of inboundSecrets) {
        const secretResult = await processSecret(
            node,
            secretEntry,
            startIndex,
            maxIndices,
            batchSize,
        );

        results.push(secretResult);
    }

    return {
        account: secretsExport.account.toString(),
        retrievedAt: Date.now(),
        secrets: results,
        totalEvents: results.reduce((sum, r) => sum + r.events.length, 0),
    };
}

/**
 * Process a single tagging secret and retrieve all matching event logs.
 */
async function processSecret(
    node: AztecNode,
    secretEntry: TaggingSecretEntry,
    startIndex: number,
    maxIndices: number,
    batchSize: number,
): Promise<EventSecretResult> {
    const events: RetrievedEvent[] = [];

    console.log(`[EventReader] Processing secret: counterparty: ${secretEntry.counterparty.toString().slice(0, 16)}...`);

    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
        const count = Math.min(batchSize, startIndex + maxIndices - index);

        // Step 1: Generate base tags (unsiloed)
        const baseTags = await TagGenerator.generateTags(secretEntry.secret, index, count);

        // Step 2: Silo each tag with the contract address
        // Formula: siloedTag = poseidon2Hash([contractAddress, baseTag])
        const siloedTags = await Promise.all(
            baseTags.map(async baseTag => {
                return await poseidon2Hash([secretEntry.app, baseTag]);
            })
        );

        console.log(`[EventReader] Generated ${siloedTags.length} siloed tags for indices ${index}-${index + count - 1}`);

        // Query logs by siloed tags
        const logsPerTag = await node.getLogsByTags(siloedTags);

        const totalLogs = logsPerTag.reduce((sum, logs) => sum + logs.length, 0);
        console.log(`[EventReader] Received ${totalLogs} logs from node`);

        // Process each tag's logs - no NoteMapper needed for events
        for (let i = 0; i < logsPerTag.length; i++) {
            const logs = logsPerTag[i];
            if (logs.length === 0) continue;

            for (const log of logs) {
                // Extract the raw encrypted log buffer
                const encryptedLog = log.log.toBuffer();

                events.push({
                    txHash: log.txHash.toString(),
                    blockNumber: log.blockNumber.toString(),
                    ciphertext: encryptedLog.toString('hex'),
                    ciphertextBuffer: encryptedLog,
                    ciphertextBytes: encryptedLog.length,
                    logIndex: log.logIndexInTx,
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
            label: secretEntry.label,
        },
        events,
        eventCount: events.length,
    };
}

/**
 * Result of retrieving encrypted events.
 */
export interface EventRetrievalResult {
    account: string;
    retrievedAt: number;
    secrets: EventSecretResult[];
    totalEvents: number;
}

/**
 * Events retrieved using a specific tagging secret.
 */
export interface EventSecretResult {
    secret: {
        counterparty: string;
        app: string;
        label?: string;
    };
    events: RetrievedEvent[];
    eventCount: number;
}

/**
 * A single retrieved event with its encrypted ciphertext.
 */
export interface RetrievedEvent {
    txHash: string;
    blockNumber: string;
    /** Encrypted log ciphertext (hex encoded) */
    ciphertext: string;
    /** Raw ciphertext buffer for circuit input */
    ciphertextBuffer: Buffer;
    /** Size of ciphertext in bytes */
    ciphertextBytes: number;
    /** Index of this log within the transaction */
    logIndex: number;
    /** Tag index that discovered this event */
    tagIndex: number;
}
