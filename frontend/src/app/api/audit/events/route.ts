import { NextRequest, NextResponse } from "next/server";
import { poseidon2Hash } from "@zkpassport/poseidon2";

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

// Domain separator for PRIVATE_LOG_FIRST_FIELD from @aztec/constants
const PRIVATE_LOG_FIRST_FIELD_SEPARATOR = 2769976252n;

interface SerializedSecretEntry {
  secret: string;
  counterparty: string;
  app: string;
  direction: string;
  label?: string;
}

interface SerializedSecretsExport {
  account: string;
  secrets: SerializedSecretEntry[];
}

interface RetrievedEvent {
  txHash: string;
  blockNumber: string;
  ciphertext: string;
  logIndex: number;
  tagIndex: number;
}

/** Generate a single tag: poseidon2Hash([secret, index]) */
function generateTag(secretValue: bigint, index: number): string {
  const hash = poseidon2Hash([secretValue, BigInt(index)]);
  return "0x" + hash.toString(16).padStart(64, "0");
}

/** Compute siloed tag: poseidon2HashWithSeparator([app, tag], PRIVATE_LOG_FIRST_FIELD) */
function computeSiloedTag(app: string, tagValue: string): string {
  // poseidon2HashWithSeparator prepends the separator to inputs
  const appBigInt = BigInt(app);
  const tagBigInt = BigInt(tagValue);
  const hash = poseidon2Hash([PRIVATE_LOG_FIRST_FIELD_SEPARATOR, appBigInt, tagBigInt]);
  return "0x" + hash.toString(16).padStart(64, "0");
}

/** Call Aztec node JSON-RPC directly */
async function getPrivateLogsByTags(siloedTags: string[]): Promise<any[][]> {
  const res = await fetch(AZTEC_NODE_URL, {
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

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SerializedSecretsExport;

    const inboundSecrets = body.secrets.filter((s) => s.direction === "inbound");
    const events: RetrievedEvent[] = [];

    for (const secretEntry of inboundSecrets) {
      // The secret string is a hex Fr value
      const secretValue = BigInt(secretEntry.secret);
      const app = secretEntry.app;
      const batchSize = 100;
      const maxIndices = 10000;

      for (let index = 0; index < maxIndices; index += batchSize) {
        const count = Math.min(batchSize, maxIndices - index);

        // Generate and silo tags
        const siloedTags: string[] = [];
        for (let i = 0; i < count; i++) {
          const baseTag = generateTag(secretValue, index + i);
          const siloedTag = computeSiloedTag(app, baseTag);
          siloedTags.push(siloedTag);
        }

        const logsPerTag = await getPrivateLogsByTags(siloedTags);

        for (let i = 0; i < logsPerTag.length; i++) {
          for (const log of logsPerTag[i]) {
            // logData is an array of hex field strings from the JSON-RPC response
            const logData: string[] = log.logData ?? [];
            const ciphertextHex = logData
              .map((f: string) => {
                // Each field is a 0x-prefixed hex string (32 bytes)
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

    events.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

    return NextResponse.json({
      events,
      totalEvents: events.length,
    });
  } catch (error: any) {
    console.error("Event retrieval error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to retrieve events" },
      { status: 500 },
    );
  }
}
