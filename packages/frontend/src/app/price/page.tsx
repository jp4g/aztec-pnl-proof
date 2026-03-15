"use client";

import { Icon } from "@iconify/react";
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

        <div className="w-full max-w-md mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 flex gap-3">
          <Icon
            icon="lucide:triangle-alert"
            width={16}
            className="text-amber-500 flex-shrink-0 mt-0.5"
          />
          <p className="text-xs text-amber-700 leading-relaxed">
            Oracle prices may be out of sync with real market prices due to
            previous demo activity. Use the{" "}
            <span className="font-semibold">Sync Live</span> button to reset
            all token prices to current CoinGecko values and rebalance the
            pools.
          </p>
        </div>

        <PriceCard />
      </main>
    </RequireWallet>
  );
}
