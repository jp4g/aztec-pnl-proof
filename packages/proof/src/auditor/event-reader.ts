import type { AztecNode } from "@aztec/aztec.js/node";
import type { ExportedTaggingSecret } from "./types";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { SiloedTag } from "@aztec/stdlib/logs";
import { computeSwapLeaf, parseSwapCiphertextFields } from '../swap-leaf';
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
 * @param node - Aztec node client for private log retrieval
 * @param historyNode - Aztec node client for historical block headers
 * @param secrets - Exported tagging secrets from a user
 * @param options - Scan options
 * @returns Retrieved encrypted event logs
 */
export async function retrieveEncryptedEvents(
    node: AztecNode,
    historyNode: AztecNode,
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
    const publicDataRootByBlock = new Map<string, string>();

    // Filter to only inbound secrets - we can only decrypt events encrypted for us
    const inboundSecrets = secrets.filter(s => s.direction === 'inbound');

    for (const entry of inboundSecrets) {
        const secretResult = await processSecret(
            node,
            historyNode,
            entry,
            startIndex,
            maxIndices,
            batchSize,
            publicDataRootByBlock,
        );

        results.push(secretResult);
    }

    const events = sortEvents(results.flatMap(r => r.events));
    const auditorRoot = (await computeAuditorRoot(events)).toString();

    return {
        retrievedAt: Date.now(),
        secrets: results,
        events,
        totalEvents: events.length,
        auditorRoot,
        ciphertextRoot: auditorRoot,
    };
}

/**
 * Process a single tagging secret and retrieve all matching event logs.
 */
async function processSecret(
    node: AztecNode,
    historyNode: AztecNode,
    entry: ExportedTaggingSecret,
    startIndex: number,
    maxIndices: number,
    batchSize: number,
    publicDataRootByBlock: Map<string, string>,
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
                const blockNumber = logEntry.blockNumber.toString();
                const publicDataTreeRoot = await getPublicDataTreeRoot(historyNode, blockNumber, publicDataRootByBlock);

                events.push({
                    txHash: logEntry.txHash.toString(),
                    blockNumber,
                    publicDataTreeRoot,
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

async function getPublicDataTreeRoot(
    historyNode: AztecNode,
    blockNumber: string,
    cache: Map<string, string>,
): Promise<string> {
    const cached = cache.get(blockNumber);
    if (cached) return cached;

    const header = await historyNode.getBlockHeader(Number(blockNumber) as any);
    if (!header) {
        throw new Error(`Block header not found for block ${blockNumber}`);
    }

    const root = header.state.partial.publicDataTree.root.toString();
    cache.set(blockNumber, root);
    return root;
}

async function computeAuditorLeaf(event: RetrievedEvent): Promise<Fr> {
    return computeSwapLeaf(parseSwapCiphertextFields(event.ciphertextBuffer), event.publicDataTreeRoot);
}

async function computeAuditorRoot(events: RetrievedEvent[]): Promise<Fr> {
    if (events.length === 0) return Fr.ZERO;

    let level = await Promise.all(events.map(event => computeAuditorLeaf(event)));
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
    /** Merkle root of ciphertext leaves bound to their public data tree roots. */
    auditorRoot: string;
    /** Back-compat alias for auditorRoot. */
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
    /** Public data tree root from this event's block header */
    publicDataTreeRoot: string;
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
