"use client";

import { Icon } from "@iconify/react";
import type { ProveFlowState } from "@/types";
import ProgressBar from "@/components/ui/ProgressBar";

interface ProofGenerationCardProps {
  state: ProveFlowState;
  onGenerate: () => void;
  onReset: () => void;
}

export default function ProofGenerationCard({
  state,
  onGenerate,
  onReset,
}: ProofGenerationCardProps) {
  const isRunning =
    state.status !== "idle" &&
    state.status !== "complete" &&
    state.status !== "error";

  const statusColor =
    state.status === "complete"
      ? "text-green-600"
      : state.status === "error"
        ? "text-red-600"
        : "text-orange-600";

  return (
    <div className="flex flex-col justify-center gap-4 bg-orange-50/50 rounded-2xl border border-orange-100 p-8">
      <div className="mb-2">
        <h3 className="text-lg font-semibold text-neutral-900 tracking-tight">
          Proof Generation
        </h3>
        <p className="text-sm text-neutral-500 mt-1">
          Status:{" "}
          <span className={`font-medium ${statusColor}`}>
            {state.statusText}
          </span>
        </p>
      </div>

      <ProgressBar progress={state.progress} />

      <div className="flex items-center justify-between text-xs text-neutral-500 font-mono mt-1">
        <span>
          {state.blockNumber
            ? `Block #${state.blockNumber}`
            : "Block #--"}
        </span>
        <span>
          {state.totalSwaps > 0
            ? `${state.currentSwap}/${state.totalSwaps} swaps`
            : "--"}
        </span>
      </div>

      {state.error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-1">
          {state.error}
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button
          onClick={onGenerate}
          disabled={isRunning}
          className="flex-1 bg-orange-600 hover:bg-orange-700 disabled:bg-neutral-300 disabled:cursor-not-allowed text-white text-sm font-medium py-3 px-4 rounded-xl shadow-sm shadow-orange-200 transition-all flex items-center justify-center gap-2 group"
        >
          {isRunning ? (
            <>
              <Icon
                icon="solar:refresh-linear"
                width={18}
                className="animate-spin"
              />
              Generating...
            </>
          ) : (
            <>
              <Icon
                icon="solar:magic-stick-3-linear"
                width={18}
                className="group-hover:rotate-12 transition-transform"
              />
              {state.status === "complete" ? "Re-generate" : "Generate ZK Proof"}
            </>
          )}
        </button>
        {(state.status === "complete" || state.status === "error") && (
          <button
            onClick={onReset}
            className="px-4 py-3 text-sm font-medium text-neutral-600 bg-white border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
