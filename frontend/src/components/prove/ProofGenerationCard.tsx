"use client";

import { Icon } from "@iconify/react";
import { ProofState } from "@/types";
import ProgressBar from "@/components/ui/ProgressBar";

interface ProofGenerationCardProps {
  proofState: ProofState;
  onGenerate: () => void;
}

export default function ProofGenerationCard({
  proofState,
  onGenerate,
}: ProofGenerationCardProps) {
  const statusText =
    proofState.status === "generating" && proofState.currentLeaf
      ? `Computing Leaf ${proofState.currentLeaf}...`
      : proofState.status === "complete"
        ? "Proof Complete"
        : "Ready to Generate";

  return (
    <div className="flex flex-col justify-center gap-4 bg-orange-50/50 rounded-2xl border border-orange-100 p-8">
      <div className="mb-2">
        <h3 className="text-lg font-semibold text-neutral-900 tracking-tight">
          Proof Generation
        </h3>
        <p className="text-sm text-neutral-500 mt-1">
          Status:{" "}
          <span className="text-orange-600 font-medium">{statusText}</span>
        </p>
      </div>

      <ProgressBar progress={proofState.progress} />

      <div className="flex items-center justify-between text-xs text-neutral-500 font-mono mt-1">
        <span>Block #{proofState.blockNumber}</span>
        <span>Est. Time: {proofState.estimatedTime}</span>
      </div>

      <button
        onClick={onGenerate}
        className="mt-4 w-full bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium py-3 px-4 rounded-xl shadow-sm shadow-orange-200 transition-all flex items-center justify-center gap-2 group"
      >
        <Icon
          icon="solar:magic-stick-3-linear"
          width={18}
          className="group-hover:rotate-12 transition-transform"
        />
        Generate ZK Proof
      </button>
    </div>
  );
}
