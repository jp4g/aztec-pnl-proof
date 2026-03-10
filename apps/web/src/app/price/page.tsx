"use client";

import PriceCard from "@/components/price/PriceCard";
import RequireWallet from "@/components/layout/RequireWallet";

export default function PricePage() {
  return (
    <RequireWallet>
      <main className="flex-grow max-w-6xl mx-auto px-6 py-16 w-full flex flex-col items-center">
        <p className="text-sm text-neutral-500 max-w-md text-center mb-6">
          Adjust oracle prices to simulate market movements and see how they
          affect your PnL statement in this demo.
        </p>
        <PriceCard />
      </main>
    </RequireWallet>
  );
}
