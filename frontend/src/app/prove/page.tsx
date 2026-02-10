"use client";

import PnlSummaryCard from "@/components/prove/PnlSummaryCard";
import ProofGenerationCard from "@/components/prove/ProofGenerationCard";
import MerkleTree from "@/components/prove/MerkleTree";
import TransactionTable from "@/components/prove/TransactionTable";
import { useProofGeneration } from "@/hooks/useProofGeneration";
import {
  dummyTransactions,
  dummyTreeLeaves,
  dummyTreeIntermediatesL1,
  dummyTreeIntermediatesL2,
  dummyTreeRoot,
} from "@/data/dummy";

export default function ProvePage() {
  const { proofState, startProofGeneration } = useProofGeneration();

  return (
    <main className="flex-grow max-w-6xl mx-auto px-6 py-12 w-full">
      {/* Header & PnL Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
        <PnlSummaryCard proofState={proofState} />
        <ProofGenerationCard
          proofState={proofState}
          onGenerate={startProofGeneration}
        />
      </div>

      {/* Merkle Tree Visualizer */}
      <MerkleTree
        leaves={dummyTreeLeaves}
        intermediatesL1={dummyTreeIntermediatesL1}
        intermediatesL2={dummyTreeIntermediatesL2}
        root={dummyTreeRoot}
      />

      {/* Transaction History */}
      <TransactionTable transactions={dummyTransactions} />
    </main>
  );
}
