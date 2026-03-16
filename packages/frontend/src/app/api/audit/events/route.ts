import { NextRequest, NextResponse } from "next/server";
import { retrieveEncryptedEvents } from "@privpnl/proof/auditor/browser";
import type { SerializedExportedTaggingSecret } from "@privpnl/proof/auditor/browser";

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SerializedExportedTaggingSecret[];
    const result = await retrieveEncryptedEvents(AZTEC_NODE_URL, body);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Event retrieval error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to retrieve events" },
      { status: 500 },
    );
  }
}
