import { NextRequest, NextResponse } from "next/server";
import { retrieveEncryptedEvents } from "@privpnl/proof/auditor/browser";
import type { SerializedExportedTaggingSecret } from "@privpnl/proof/auditor/browser";

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";
const AZTEC_ARCHIVAL_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_ARCHIVAL_NODE_URL || AZTEC_NODE_URL;
const PRICE_FEED_ADDRESS = process.env.NEXT_PUBLIC_PRICE_FEED;

export async function POST(request: NextRequest) {
  try {
    if (!PRICE_FEED_ADDRESS) {
      throw new Error("NEXT_PUBLIC_PRICE_FEED is required for audit response");
    }

    const body = (await request.json()) as SerializedExportedTaggingSecret[];
    const result = await retrieveEncryptedEvents(AZTEC_NODE_URL, AZTEC_ARCHIVAL_NODE_URL, body);
    return NextResponse.json({ ...result, priceFeedAddress: PRICE_FEED_ADDRESS });
  } catch (error: any) {
    console.error("Event retrieval error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to retrieve events" },
      { status: 500 },
    );
  }
}
