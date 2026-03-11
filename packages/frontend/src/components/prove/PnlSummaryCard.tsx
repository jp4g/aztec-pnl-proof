"use client";

import { Icon } from "@iconify/react";
import type { ProveFlowState } from "@/types";

interface PnlSummaryCardProps {
  state: ProveFlowState;
  formatPnl: (pnl: bigint) => string;
}

export default function PnlSummaryCard({ state, formatPnl }: PnlSummaryCardProps) {
  const isComplete = state.status === "complete";
  const pnlPositive = state.pnl !== null ? state.pnl >= 0n : true;
  const pnlDisplay = state.pnl !== null ? formatPnl(state.pnl) : "--";
  const taxDisplay =
    state.tax !== null ? formatPnl(state.tax) : "--";

  return (
    <div className="lg:col-span-2 bg-white rounded-2xl border border-neutral-200 p-8 shadow-sm relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
        <Icon icon="solar:shield-check-linear" width={120} className="text-orange-500" />
      </div>
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-medium text-neutral-500 uppercase tracking-wider">
            Net Realized PnL
          </span>
          {isComplete && (
            <Icon icon="solar:verified-check-bold" className="text-green-500" width={16} />
          )}
        </div>
        <div className="flex items-baseline gap-4 mb-2">
          <h1 className="text-5xl font-semibold tracking-tight text-neutral-900 font-mono">
            {pnlDisplay}
          </h1>
          {state.pnl !== null && (
            <span
              className={`inline-flex items-center gap-1 text-sm font-medium px-2 py-1 rounded-md ${
                pnlPositive
                  ? "text-green-600 bg-green-50"
                  : "text-red-600 bg-red-50"
              }`}
            >
              <Icon
                icon={
                  pnlPositive
                    ? "solar:graph-up-linear"
                    : "solar:graph-down-linear"
                }
                width={14}
              />
              {pnlPositive ? "Gain" : "Loss"}
            </span>
          )}
        </div>

        {state.tax !== null && (
          <div className="flex items-center gap-2 mt-2 text-sm text-neutral-600">
            <Icon icon="solar:bill-list-linear" width={16} className="text-neutral-400" />
            <span>Tax (20%): <span className="font-mono font-medium">{taxDisplay}</span></span>
          </div>
        )}

        <p className="text-sm text-neutral-500 max-w-md mt-4 leading-relaxed">
          {isComplete
            ? `Proven over ${state.totalSwaps} encrypted swap transactions. ZK proof verifies your returns without revealing trade history.`
            : state.status === "idle"
              ? "Generate a Zero-Knowledge proof to calculate and verify your trading PnL on-chain."
              : "Proof generation in progress..."}
        </p>
      </div>
    </div>
  );
}
