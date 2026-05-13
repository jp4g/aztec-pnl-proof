import type { AztecNode } from "@aztec/aztec.js/node";
import type { ExportedTaggingSecret } from "./types";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash, poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon";
import { SiloedTag } from "@aztec/stdlib/logs";
import { MESSAGE_CIPHERTEXT_LEN, TAG_SIZE } from '../constants';
import { getZeroHashes } from '../imt';
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

    const events = sortEvents(results.flatMap(r => r.events));

    return {
        retrievedAt: Date.now(),
        secrets: results,
        events,
        totalEvents: events.length,
        ciphertextRoot: (await computeCiphertextRoot(events)).toString(),
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

        // v4 computes the raw tag, log-domain-separated tag, and app silo in one step.
        const siloedTags = await Promise.all(
            Array.from({ length: count }, (_, offset) =>
                SiloedTag.compute({
                    extendedSecret: entry.secret,
                    index: index + offset,
                }),
            ),
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
                    contractAddress: entry.secret.app.toString(),
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

function sortEvents(events: RetrievedEvent[]): RetrievedEvent[] {
    return [...events].sort((a, b) => {
        const aBlock = BigInt(a.blockNumber);
        const bBlock = BigInt(b.blockNumber);
        if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
        const txDiff = a.txHash.localeCompare(b.txHash);
        if (txDiff !== 0) return txDiff;
        if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
        return a.tagIndex - b.tagIndex;
    });
}

async function computeCiphertextLeaf(ciphertextBuffer: Buffer): Promise<Fr> {
    const ciphertextWithoutTag = ciphertextBuffer.slice(TAG_SIZE);
    const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
    ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

    const ciphertextFields: Fr[] = [];
    for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
        ciphertextFields.push(Fr.fromBuffer(paddedBuffer.slice(i * 32, (i + 1) * 32)));
    }

    return poseidon2HashWithSeparator(ciphertextFields, 0);
}

async function computeCiphertextRoot(events: RetrievedEvent[]): Promise<Fr> {
    if (events.length === 0) return Fr.ZERO;

    let level = await Promise.all(events.map(event => computeCiphertextLeaf(event.ciphertextBuffer)));
    const zeroHashes = await getZeroHashes(Math.max(1, Math.ceil(Math.log2(level.length)) + 1));

    if (level.length === 1) {
        return poseidon2Hash([level[0], zeroHashes[0]]);
    }

    for (let depth = 0; level.length > 1; depth++) {
        const nextLevel: Fr[] = [];
        for (let i = 0; i < level.length; i += 2) {
            nextLevel.push(await poseidon2Hash([level[i], level[i + 1] ?? zeroHashes[depth]]));
        }
        level = nextLevel;
    }

    return level[0];
}

/**
 * Result of retrieving encrypted events.
 */
export interface EventRetrievalResult {
    retrievedAt: number;
    /** All retrieved events sorted in the order used for the ciphertext tree. */
    events: RetrievedEvent[];
    secrets: EventSecretResult[];
    totalEvents: number;
    /** Merkle root of all returned ciphertext leaves. */
    ciphertextRoot: string;
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
    /** Contract that emitted the encrypted event */
    contractAddress: string;
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
