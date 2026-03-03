import { NextRequest, NextResponse } from "next/server";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TagGenerator } from "@proof/auditor";
import { DirectionalAppTaggingSecret } from "@aztec/stdlib/logs";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SerializedSecretsExport;

    // Connect to the Aztec node
    const node = createAztecNodeClient(AZTEC_NODE_URL);

    // Filter to only inbound secrets
    const inboundSecrets = body.secrets.filter((s) => s.direction === "inbound");
    const events: RetrievedEvent[] = [];

    for (const secretEntry of inboundSecrets) {
      const secret = DirectionalAppTaggingSecret.fromString(secretEntry.secret);
      const app = AztecAddress.fromString(secretEntry.app);
      const batchSize = 100;
      const maxIndices = 10000;

      for (let index = 0; index < maxIndices; index += batchSize) {
        const count = Math.min(batchSize, maxIndices - index);
        const baseTags = await TagGenerator.generateTags(secret, index, count);
        const siloedTags = await Promise.all(
          baseTags.map(async (baseTag) => poseidon2Hash([app, baseTag]))
        );

        const logsPerTag = await node.getLogsByTags(siloedTags);

        for (let i = 0; i < logsPerTag.length; i++) {
          for (const log of logsPerTag[i]) {
            events.push({
              txHash: log.txHash.toString(),
              blockNumber: log.blockNumber.toString(),
              ciphertext: log.log.toBuffer().toString("hex"),
              logIndex: log.logIndexInTx,
              tagIndex: index + i,
            });
          }
        }

        if (logsPerTag.every((logs) => logs.length === 0)) {
          break;
        }
      }
    }

    // Sort chronologically
    events.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

    return NextResponse.json({
      events,
      totalEvents: events.length,
    });
  } catch (error: any) {
    console.error("Event retrieval error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to retrieve events" },
      { status: 500 }
    );
  }
}
