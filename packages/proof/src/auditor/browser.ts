import { poseidon2Hash } from "@zkpassport/poseidon2";
import { MESSAGE_CIPHERTEXT_LEN, TAG_SIZE } from "../constants";

export type {
  SerializedExportedTaggingSecret,
} from "./types";
export {
  serializeExportedTaggingSecrets,
} from "./serialization";

import type {
  SerializedExportedTaggingSecret,
} from "./types";

// Domain separators from @aztec/constants.
const UNCONSTRAINED_MSG_LOG_TAG_SEPARATOR = 1485357192n;
const PRIVATE_LOG_FIRST_FIELD_SEPARATOR = 2769976252n;

/** A single retrieved event (browser-friendly, no Buffer). */
export interface BrowserRetrievedEvent {
  txHash: string;
  blockNumber: string;
  /** Public data tree root from this event's block header */
  publicDataTreeRoot: string;
  /** Contract that emitted the encrypted event */
  contractAddress: string;
  /** Encrypted log ciphertext (hex encoded, no 0x prefix) */
  ciphertext: string;
  logIndex: number;
  tagIndex: number;
}

/** Result of browser-based event retrieval. */
export interface BrowserEventRetrievalResult {
  events: BrowserRetrievedEvent[];
  totalEvents: number;
  /** Merkle root of ciphertext leaves bound to their public data tree roots. */
  auditorRoot: string;
  /** Back-compat alias for auditorRoot. */
  ciphertextRoot: string;
}

function toHexField(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

function parseSerializedSecret(secret: string): { secretValue: bigint; app: string } {
  const [secretValue, app] = secret.split(':');
  if (!secretValue || !app) {
    throw new Error(`Invalid secret format — expected "0xSECRET:0xAPP", got "${secret}"`);
  }
  return { secretValue: BigInt(secretValue), app };
}

function computeSiloedTag(secretValue: bigint, app: string, index: number): string {
  const tag = poseidon2Hash([secretValue, BigInt(index)]);
  const logTag = poseidon2Hash([UNCONSTRAINED_MSG_LOG_TAG_SEPARATOR, tag]);
  const siloedTag = poseidon2Hash([PRIVATE_LOG_FIRST_FIELD_SEPARATOR, BigInt(app), logTag]);
  return toHexField(siloedTag);
}

function computeZeroHashes(maxDepth: number): bigint[] {
  const zeroHashes = [0n];
  for (let i = 1; i <= maxDepth; i++) {
    const previous = zeroHashes[i - 1];
    zeroHashes.push(poseidon2Hash([previous, previous]));
  }
  return zeroHashes;
}

function computeAuditorLeaf(event: BrowserRetrievedEvent): bigint {
  const { ciphertext, publicDataTreeRoot } = event;
  const ciphertextHex = ciphertext.startsWith("0x") ? ciphertext.slice(2) : ciphertext;
  const ciphertextWithoutTag = ciphertextHex.slice(TAG_SIZE * 2);
  const paddedCiphertext = ciphertextWithoutTag
    .padEnd(MESSAGE_CIPHERTEXT_LEN * 64, "0")
    .slice(0, MESSAGE_CIPHERTEXT_LEN * 64);
  const fields: bigint[] = [];

  for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
    fields.push(BigInt("0x" + paddedCiphertext.slice(i * 64, (i + 1) * 64)));
  }

  return poseidon2Hash([...fields, BigInt(publicDataTreeRoot)]);
}

function computeAuditorRoot(events: BrowserRetrievedEvent[]): string {
  if (events.length === 0) return toHexField(0n);

  let level = events.map((event) => computeAuditorLeaf(event));
  const zeroHashes = computeZeroHashes(Math.max(1, Math.ceil(Math.log2(level.length)) + 1));

  if (level.length === 1) {
    return toHexField(poseidon2Hash([level[0], zeroHashes[0]]));
  }

  for (let depth = 0; level.length > 1; depth++) {
    const nextLevel: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(poseidon2Hash([level[i], level[i + 1] ?? zeroHashes[depth]]));
    }
    level = nextLevel;
  }

  return toHexField(level[0]);
}

/** Fetch a historical block header root from an Aztec node JSON-RPC endpoint. */
async function getPublicDataTreeRoot(
  historyNodeUrl: string,
  blockNumber: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(blockNumber);
  if (cached) return cached;

  const res = await fetch(historyNodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "node_getBlockHeader",
      params: [Number(blockNumber)],
    }),
  });

  if (!res.ok) {
    throw new Error(`Aztec history node returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Aztec history node RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  if (!json.result) {
    throw new Error(`Block header not found for block ${blockNumber}`);
  }

  const root = json.result?.state?.partial?.publicDataTree?.root;
  if (typeof root !== "string") {
    throw new Error(`Block header for block ${blockNumber} is missing state.partial.publicDataTree.root`);
  }

  cache.set(blockNumber, root);
  return root;
}

/** Call Aztec node JSON-RPC directly */
async function getPrivateLogsByTags(nodeUrl: string, siloedTags: string[]): Promise<any[][]> {
  const res = await fetch(nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "node_getPrivateLogsByTags",
      params: [siloedTags],
    }),
  });

  if (!res.ok) {
    throw new Error(`Aztec node returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Aztec node RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  return json.result;
}

function sortEvents(events: BrowserRetrievedEvent[]): BrowserRetrievedEvent[] {
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

function assertUnambiguousBlockOrder(events: BrowserRetrievedEvent[]): BrowserRetrievedEvent[] {
  const eventsByBlock = new Map<string, number>();
  for (const event of events) {
    eventsByBlock.set(event.blockNumber, (eventsByBlock.get(event.blockNumber) ?? 0) + 1);
  }

  for (const [blockNumber, count] of eventsByBlock) {
    if (count > 1) {
      throw new Error(
        `Cannot prove ${count} swap events from block ${blockNumber}: ` +
        "Aztec private log retrieval does not expose sequencer tx/log order within a block.",
      );
    }
  }

  return events;
}

/**
 * Retrieve encrypted events from the Aztec network using tagging secrets.
 *
 * Lightweight implementation with zero @aztec/* dependencies.
 * Uses @zkpassport/poseidon2 for hashing and raw fetch() for JSON-RPC.
 * Suitable for browser/server environments (Next.js routes, etc.).
 *
 * @param nodeUrl - Aztec node JSON-RPC endpoint URL
 * @param historyNodeUrl - Aztec node JSON-RPC endpoint URL with historical block headers
 * @param secrets - Serialized exported tagging secrets
 * @param options - Optional scan parameters
 */
export async function retrieveEncryptedEvents(
  nodeUrl: string,
  historyNodeUrl: string,
  secrets: SerializedExportedTaggingSecret[],
  options?: {
    startIndex?: number;
    maxIndices?: number;
    batchSize?: number;
  },
): Promise<BrowserEventRetrievalResult> {
  const startIndex = options?.startIndex ?? 0;
  const maxIndices = options?.maxIndices ?? 10000;
  const batchSize = options?.batchSize ?? 100;

  const inboundSecrets = secrets.filter((s) => s.direction === "inbound");
  const events: BrowserRetrievedEvent[] = [];
  const publicDataRootByBlock = new Map<string, string>();

  for (const entry of inboundSecrets) {
    const { secretValue, app } = parseSerializedSecret(entry.secret);

    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
      const count = Math.min(batchSize, startIndex + maxIndices - index);

      const siloedTags: string[] = [];
      for (let i = 0; i < count; i++) {
        siloedTags.push(computeSiloedTag(secretValue, app, index + i));
      }

      const logsPerTag = await getPrivateLogsByTags(nodeUrl, siloedTags);

      for (let i = 0; i < logsPerTag.length; i++) {
        for (const log of logsPerTag[i]) {
          const logData: string[] = log.logData ?? [];
          const ciphertextHex = logData
            .map((f: string) => {
              const hex = f.startsWith("0x") ? f.slice(2) : f;
              return hex.padStart(64, "0");
            })
            .join("");
          const blockNumber = String(log.blockNumber);
          const publicDataTreeRoot = await getPublicDataTreeRoot(historyNodeUrl, blockNumber, publicDataRootByBlock);

          events.push({
            txHash: log.txHash,
            blockNumber,
            publicDataTreeRoot,
            contractAddress: app,
            ciphertext: ciphertextHex,
            logIndex: 0,
            tagIndex: index + i,
          });
        }
      }

      if (logsPerTag.every((logs: any[]) => logs.length === 0)) {
        break;
      }
    }
  }

  const sortedEvents = sortEvents(assertUnambiguousBlockOrder(events));
  const auditorRoot = computeAuditorRoot(sortedEvents);

  return {
    events: sortedEvents,
    totalEvents: sortedEvents.length,
    auditorRoot,
    ciphertextRoot: auditorRoot,
  };
}
