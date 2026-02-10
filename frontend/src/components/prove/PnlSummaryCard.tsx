"use client";

import { Icon } from "@iconify/react";
import { ProofState } from "@/types";

interface PnlSummaryCardProps {
  proofState: ProofState;
}

export default function PnlSummaryCard({ proofState }: PnlSummaryCardProps) {
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
          <Icon icon="solar:eye-closed-linear" className="text-neutral-400" width={16} />
        </div>
        <div className="flex items-baseline gap-4 mb-2">
          <h1 className="text-5xl font-semibold tracking-tight text-neutral-900 font-mono">
            {proofState.pnlAmount}
          </h1>
          <span
            className={`inline-flex items-center gap-1 text-sm font-medium px-2 py-1 rounded-md ${
              proofState.pnlPositive
                ? "text-green-600 bg-green-50"
                : "text-red-600 bg-red-50"
            }`}
          >
            <Icon
              icon={
                proofState.pnlPositive
                  ? "solar:graph-up-linear"
                  : "solar:graph-down-linear"
              }
              width={14}
            />
            {proofState.pnlPercent}
          </span>
        </div>
        <p className="text-sm text-neutral-500 max-w-md mt-4 leading-relaxed">
          Your profit is calculated locally over {proofState.totalTransactions}{" "}
          encrypted swap transactions. Generate a Zero-Knowledge proof to verify
          your returns on-chain without revealing trade history.
        </p>
      </div>
    </div>
  );
}
