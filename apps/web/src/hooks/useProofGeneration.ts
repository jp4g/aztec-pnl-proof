"use client";

import { useState, useCallback } from "react";
import { ProofState } from "@/types";
import { dummyProofState } from "@/data/dummy";

export function useProofGeneration() {
  const [proofState, setProofState] = useState<ProofState>(dummyProofState);

  const startProofGeneration = useCallback(() => {
    setProofState((prev) => ({
      ...prev,
      status: "generating",
      progress: 0,
      currentLeaf: 1,
    }));
  }, []);

  const resetProof = useCallback(() => {
    setProofState(dummyProofState);
  }, []);

  return {
    proofState,
    startProofGeneration,
    resetProof,
  };
}
