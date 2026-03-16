import type { AztecNode } from "@aztec/aztec.js/node";
import { TagGenerator } from "./tag-generator";
import type { ExportedTaggingSecret } from "./types";
import { Tag, SiloedTag } from "@aztec/stdlib/logs";
import { log } from '../logger';

/**
 * Scan for encrypted event logs using tagging secrets.
 *
 * Adapted from the old auditor.ts. Key differences from note scanning:
 * - Events don't map to note hashes, so no NoteMapper is needed
 * - Returns raw encrypted log buffers (ciphertexts) for circuit proving
 * - Only processes INBOUND secrets (events encrypted for the account holder)
 *
 * @param node - Aztec node client
 * @param secrets - Exported tagging secrets from a user
 * @param options - Scan options
 * @returns Retrieved encrypted event logs
 */
export async function retrieveEncryptedEvents(
    node: AztecNode,
    secrets: ExportedTaggingSecret[],
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
    const inboundSecrets = secrets.filter(s => s.direction === 'inbound');

    for (const entry of inboundSecrets) {
        const secretResult = await processSecret(
            node,
            entry,
            startIndex,
            maxIndices,
            batchSize,
        );

        results.push(secretResult);
    }

    return {
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
    entry: ExportedTaggingSecret,
    startIndex: number,
    maxIndices: number,
    batchSize: number,
): Promise<EventSecretResult> {
    const events: RetrievedEvent[] = [];

    log(`[EventReader] Processing secret: counterparty: ${entry.counterparty.toString().slice(0, 16)}...`);

    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
        const count = Math.min(batchSize, startIndex + maxIndices - index);

        // Step 1: Generate base tags (unsiloed)
        const baseTags = await TagGenerator.generateTags(entry.secret, index, count);

        // Step 2: Silo each tag with the contract address (v4 uses domain-separated hash)
        const app = entry.secret.app;
        const siloedTags = await Promise.all(
            baseTags.map(baseTag => SiloedTag.compute(new Tag(baseTag), app))
        );

        log(`[EventReader] Generated ${siloedTags.length} siloed tags for indices ${index}-${index + count - 1}`);

        // Query logs by siloed tags (v4 API)
        const logsPerTag = await node.getPrivateLogsByTags(siloedTags);

        const totalLogs = logsPerTag.reduce((sum, logs) => sum + logs.length, 0);
        log(`[EventReader] Received ${totalLogs} logs from node`);

        // Process each tag's logs - no NoteMapper needed for events
        for (let i = 0; i < logsPerTag.length; i++) {
            const logs = logsPerTag[i];
            if (logs.length === 0) continue;

            for (const logEntry of logs) {
                // v4: logData is Fr[], concatenate to buffer
                const encryptedLog = Buffer.concat(logEntry.logData.map(f => f.toBuffer()));

                events.push({
                    txHash: logEntry.txHash.toString(),
                    blockNumber: logEntry.blockNumber.toString(),
                    ciphertext: encryptedLog.toString('hex'),
                    ciphertextBuffer: encryptedLog,
                    ciphertextBytes: encryptedLog.length,
                    logIndex: 0, // v4 TxScopedL2Log doesn't expose logIndexInTx
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
            counterparty: entry.counterparty.toString(),
            app: entry.secret.app.toString(),
        },
        events,
        eventCount: events.length,
    };
}

/**
 * Result of retrieving encrypted events.
 */
export interface EventRetrievalResult {
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
