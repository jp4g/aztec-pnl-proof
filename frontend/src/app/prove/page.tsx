"use client";

import PnlSummaryCard from "@/components/prove/PnlSummaryCard";
import ProofGenerationCard from "@/components/prove/ProofGenerationCard";
import MerkleTree from "@/components/prove/MerkleTree";
import TransactionTable from "@/components/prove/TransactionTable";
import { useProveFlow } from "@/hooks/useProveFlow";
import RequireWallet from "@/components/layout/RequireWallet";

export default function ProvePage() {
  const { state, startProving, downloadProof, resolveToken, formatAmount, formatPnl } =
    useProveFlow();

  return (
    <RequireWallet>
      <main className="flex-grow max-w-6xl mx-auto px-6 py-12 w-full">
        {/* Header & PnL Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
          <PnlSummaryCard state={state} formatPnl={formatPnl} />
          <ProofGenerationCard
            state={state}
            onGenerate={startProving}
            onDownload={downloadProof}
          />
        </div>

        {/* Merkle Tree Visualizer */}
        <MerkleTree levels={state.treeLevels} />

        {/* Transaction History */}
        <TransactionTable
          swaps={state.swaps}
          status={state.status}
          currentSwap={state.currentSwap}
          resolveToken={resolveToken}
          formatAmount={formatAmount}
        />
      </main>
    </RequireWallet>
  );
}
