"use client";

import SwapCard from "@/components/trade/SwapCard";
import RequireWallet from "@/components/layout/RequireWallet";

export default function TradePage() {
  return (
    <RequireWallet>
      <main className="flex-grow max-w-6xl mx-auto px-6 py-16 w-full flex flex-col items-center">
        <SwapCard />
      </main>
    </RequireWallet>
  );
}
