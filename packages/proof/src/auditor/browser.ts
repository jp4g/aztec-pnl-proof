import { poseidon2Hash } from "@zkpassport/poseidon2";

export type {
  SerializedExportedTaggingSecret,
} from "./types";

import type {
  SerializedExportedTaggingSecret,
} from "./types";

// Domain separator for PRIVATE_LOG_FIRST_FIELD from @aztec/constants
const PRIVATE_LOG_FIRST_FIELD_SEPARATOR = 2769976252n;

/** A single retrieved event (browser-friendly, no Buffer). */
export interface BrowserRetrievedEvent {
  txHash: string;
  blockNumber: string;
  /** Encrypted log ciphertext (hex encoded, no 0x prefix) */
  ciphertext: string;
  logIndex: number;
  tagIndex: number;
}

/** Result of browser-based event retrieval. */
export interface BrowserEventRetrievalResult {
  events: BrowserRetrievedEvent[];
  totalEvents: number;
}

/** Generate a single tag: poseidon2Hash([secret, index]) */
function generateTag(secretValue: bigint, index: number): string {
  const hash = poseidon2Hash([secretValue, BigInt(index)]);
  return "0x" + hash.toString(16).padStart(64, "0");
}

/** Compute siloed tag: poseidon2HashWithSeparator([app, tag], PRIVATE_LOG_FIRST_FIELD) */
function computeSiloedTag(app: string, tagValue: string): string {
  const appBigInt = BigInt(app);
  const tagBigInt = BigInt(tagValue);
  const hash = poseidon2Hash([PRIVATE_LOG_FIRST_FIELD_SEPARATOR, appBigInt, tagBigInt]);
  return "0x" + hash.toString(16).padStart(64, "0");
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

/**
 * Parse the app address from a serialized ExtendedDirectionalAppTaggingSecret string.
 * Format is "0xSECRET:0xAPP", where APP is the contract address.
 */
function parseAppFromSecret(secretStr: string): string {
  const colonIdx = secretStr.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid secret format — expected "0xSECRET:0xAPP", got "${secretStr}"`);
  }
  return secretStr.slice(colonIdx + 1);
}

/**
 * Retrieve encrypted events from the Aztec network using tagging secrets.
 *
 * Lightweight implementation with zero @aztec/* dependencies.
 * Uses @zkpassport/poseidon2 for hashing and raw fetch() for JSON-RPC.
 * Suitable for browser/server environments (Next.js routes, etc.).
 *
 * @param nodeUrl - Aztec node JSON-RPC endpoint URL
 * @param secrets - Serialized exported tagging secrets
 * @param options - Optional scan parameters
 */
export async function retrieveEncryptedEvents(
  nodeUrl: string,
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

  for (const entry of inboundSecrets) {
    // secret is "0xSECRET:0xAPP" (ExtendedDirectionalAppTaggingSecret)
    const secretStr = entry.secret.includes(':') ? entry.secret.split(':')[0] : entry.secret;
    const secretValue = BigInt(secretStr);
    const app = parseAppFromSecret(entry.secret);

    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
      const count = Math.min(batchSize, startIndex + maxIndices - index);

      // Generate and silo tags
      const siloedTags: string[] = [];
      for (let i = 0; i < count; i++) {
        const baseTag = generateTag(secretValue, index + i);
        const siloedTag = computeSiloedTag(app, baseTag);
        siloedTags.push(siloedTag);
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

          events.push({
            txHash: log.txHash,
            blockNumber: String(log.blockNumber),
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

  // Sort by block number and deduplicate by txHash
  events.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    if (seen.has(e.txHash)) return false;
    seen.add(e.txHash);
    return true;
  });

  return {
    events: unique,
    totalEvents: unique.length,
  };
}
