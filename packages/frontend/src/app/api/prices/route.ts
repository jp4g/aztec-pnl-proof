import { NextResponse } from "next/server";

const COINGECKO_IDS: Record<string, string> = {
  wETH: "ethereum",
  wZEC: "zcash",
  wAZTEC: "aztec",
};

export interface LivePrices {
  USDC: number;
  wETH: number;
  wZEC: number;
  wAZTEC: number;
}

export async function GET() {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "CoinGecko API key not configured on server" },
      { status: 503 },
    );
  }

  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { "x-cg-demo-api-key": apiKey },
      next: { revalidate: 30 },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `CoinGecko API error: ${res.status} ${text}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as Record<string, { usd: number }>;

    const ethPrice = data[COINGECKO_IDS.wETH]?.usd;
    const zecPrice = data[COINGECKO_IDS.wZEC]?.usd;
    const aztecPrice = data[COINGECKO_IDS.wAZTEC]?.usd;

    if (!ethPrice || !zecPrice || !aztecPrice) {
      return NextResponse.json(
        { error: "Incomplete price data from CoinGecko" },
        { status: 502 },
      );
    }

    const prices: LivePrices = {
      USDC: 1.0,
      wETH: ethPrice,
      wZEC: zecPrice,
      wAZTEC: aztecPrice,
    };

    return NextResponse.json(prices);
  } catch (error: any) {
    console.error("Price fetch error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to fetch prices" },
      { status: 500 },
    );
  }
}
