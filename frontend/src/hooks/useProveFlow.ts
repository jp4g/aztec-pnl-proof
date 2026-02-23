"use client";

import { useState, useCallback, useRef } from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import type {
  ProveFlowState,
  DecodedSwap,
  TreeNode,
  TreeNodeStatus,
} from "@/types";
import { TOKENS } from "@/data/dummy";

/** Map token contract addresses to symbols for display */
const TOKEN_ADDRESS_MAP: Record<string, { symbol: string; color: string }> = {};

function initTokenAddressMap() {
  const envMap: Record<string, keyof typeof TOKENS> = {
    NEXT_PUBLIC_TOKEN_USDC: "USDC",
    NEXT_PUBLIC_TOKEN_WETH: "wETH",
    NEXT_PUBLIC_TOKEN_WZEC: "wZEC",
    NEXT_PUBLIC_TOKEN_WAZTEC: "wAZTEC",
  };
  for (const [envKey, symbol] of Object.entries(envMap)) {
    const addr = process.env[envKey];
    if (addr) {
      TOKEN_ADDRESS_MAP[addr.toLowerCase()] = TOKENS[symbol];
    }
  }
}
initTokenAddressMap();

function resolveToken(address: string) {
  return TOKEN_ADDRESS_MAP[address.toLowerCase()] ?? { symbol: address.slice(0, 10), color: "bg-gray-100" };
}

/** Format bigint amounts to human-readable (divide by 10^6 for USDC-like decimals) */
function formatAmount(amount: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

function formatPnl(pnl: bigint): string {
  const sign = pnl >= 0n ? "+" : "-";
  const abs = pnl < 0n ? -pnl : pnl;
  // PnL is in raw units (amount * price), display as integer
  return `${sign}${abs.toLocaleString()}`;
}

const INITIAL_TREE_ROOT: TreeNode = { id: "root", status: "pending", label: "Root" };

function makeInitialState(): ProveFlowState {
  return {
    status: "idle",
    totalEvents: 0,
    currentSwap: 0,
    totalSwaps: 0,
    statusText: "Ready to generate proof",
    progress: 0,
    pnl: null,
    tax: null,
    merkleRoot: null,
    blockNumber: null,
    proof: null,
    swaps: [],
    treeLeaves: [],
    treeIntermediatesL1: [],
    treeIntermediatesL2: [],
    treeRoot: INITIAL_TREE_ROOT,
    error: null,
  };
}

/** Build tree visualization nodes for a given number of leaves */
function buildTreeNodes(
  totalLeaves: number,
  provenCount: number,
  currentProving: number | null,
): {
  treeLeaves: TreeNode[];
  treeIntermediatesL2: TreeNode[];
  treeIntermediatesL1: TreeNode[];
  treeRoot: TreeNode;
} {
  // Pad to next power of 2, min 8
  const padded = Math.max(8, Math.pow(2, Math.ceil(Math.log2(Math.max(totalLeaves, 1)))));

  const leaves: TreeNode[] = [];
  for (let i = 0; i < padded; i++) {
    let status: TreeNodeStatus;
    if (i >= totalLeaves) {
      status = "unused";
    } else if (i < provenCount) {
      status = "verified";
    } else if (currentProving !== null && i === currentProving) {
      status = "proving";
    } else {
      status = "pending";
    }
    leaves.push({
      id: `leaf-${i}`,
      status,
      label: i < totalLeaves ? `Tx ${i + 1}` : "Pad",
    });
  }

  // Level 2 intermediates (padded/2 nodes)
  const l2Count = padded / 2;
  const intermediatesL2: TreeNode[] = [];
  for (let i = 0; i < l2Count; i++) {
    const leftIdx = i * 2;
    const rightIdx = i * 2 + 1;
    const leftDone = leaves[leftIdx].status === "verified";
    const rightDone = leaves[rightIdx].status === "verified";
    const anyProving = leaves[leftIdx].status === "proving" || leaves[rightIdx].status === "proving";
    const bothUnused = leaves[leftIdx].status === "unused" && leaves[rightIdx].status === "unused";

    let status: TreeNodeStatus;
    if (bothUnused) status = "unused";
    else if (leftDone && rightDone) status = "verified";
    else if (anyProving) status = "proving";
    else status = "pending";

    intermediatesL2.push({ id: `int-2-${i}`, status });
  }

  // Level 1 intermediates (padded/4 nodes)
  const l1Count = padded / 4;
  const intermediatesL1: TreeNode[] = [];
  for (let i = 0; i < l1Count; i++) {
    const leftIdx = i * 2;
    const rightIdx = i * 2 + 1;
    const leftDone = intermediatesL2[leftIdx]?.status === "verified";
    const rightDone = intermediatesL2[rightIdx]?.status === "verified" || intermediatesL2[rightIdx]?.status === "unused";
    const bothUnused = intermediatesL2[leftIdx]?.status === "unused" && (intermediatesL2[rightIdx]?.status === "unused" || !intermediatesL2[rightIdx]);

    let status: TreeNodeStatus;
    if (bothUnused) status = "unused";
    else if (leftDone && rightDone) status = "verified";
    else status = "pending";

    intermediatesL1.push({ id: `int-1-${i}`, status });
  }

  // Root
  const allL1Done = intermediatesL1.every(
    (n) => n.status === "verified" || n.status === "unused"
  );
  const root: TreeNode = {
    id: "root",
    status: allL1Done && provenCount === totalLeaves ? "verified" : "pending",
    label: "Root",
  };

  return {
    treeLeaves: leaves,
    treeIntermediatesL2: intermediatesL2.slice(0, 4),
    treeIntermediatesL1: intermediatesL1.slice(0, 2),
    treeRoot: root,
  };
}

export function useProveFlow() {
  const { wallet, address } = useAztecWallet();
  const [state, setState] = useState<ProveFlowState>(makeInitialState());
  const abortRef = useRef(false);

  const startProving = useCallback(async () => {
    if (!wallet || !address) return;
    abortRef.current = false;

    setState({
      ...makeInitialState(),
      status: "discovering",
      statusText: "Discovering encrypted swap events...",
      progress: 5,
    });

    try {
      // --- Step 1: Get audit inputs from wallet ---
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const account = AztecAddress.fromString(address);

      const poolAddresses = [
        process.env.NEXT_PUBLIC_AMM_ETH_USDC,
        process.env.NEXT_PUBLIC_AMM_ZEC_USDC,
        process.env.NEXT_PUBLIC_AMM_AZTEC_USDC,
      ]
        .filter(Boolean)
        .map((a) => AztecAddress.fromString(a!));

      const { secrets, ivskM, completeAddress } =
        await wallet.getAuditProofInputs(account, poolAddresses);

      if (abortRef.current) return;

      // --- Step 2: Fetch events via API route ---
      setState((prev) => ({
        ...prev,
        statusText: "Fetching events from chain...",
        progress: 10,
      }));

      const serializedSecrets = {
        account: secrets.account.toString(),
        secrets: secrets.secrets.map((s: any) => ({
          secret: s.secret.toString(),
          counterparty: s.counterparty.toString(),
          app: s.app.toString(),
          direction: s.direction,
          label: s.label,
        })),
      };

      const eventsRes = await fetch("/api/audit/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializedSecrets),
      });

      if (!eventsRes.ok) {
        throw new Error(`Event retrieval failed: ${eventsRes.statusText}`);
      }

      const eventsData = await eventsRes.json();
      const encryptedEvents = eventsData.events as Array<{
        txHash: string;
        blockNumber: string;
        ciphertext: string;
        logIndex: number;
      }>;

      if (encryptedEvents.length === 0) {
        setState((prev) => ({
          ...prev,
          status: "complete",
          statusText: "No swap events found",
          progress: 100,
          totalEvents: 0,
        }));
        return;
      }

      const totalSwaps = encryptedEvents.length;

      // Build initial tree visualization
      const treeViz = buildTreeNodes(totalSwaps, 0, null);

      setState((prev) => ({
        ...prev,
        totalEvents: totalSwaps,
        totalSwaps,
        statusText: `Found ${totalSwaps} swap events. Loading circuits...`,
        progress: 15,
        ...treeViz,
      }));

      if (abortRef.current) return;

      // --- Step 3: Load circuit artifacts ---
      const [individualSwapJson, swapSummaryTreeJson, capitalGainsTaxJson] =
        await Promise.all([
          fetch("/circuits/individual_swap.json").then((r) => r.json()),
          fetch("/circuits/swap_summary_tree.json").then((r) => r.json()),
          fetch("/circuits/capital_gains_tax.json").then((r) => r.json()),
        ]);

      setState((prev) => ({
        ...prev,
        statusText: "Initializing proof engine...",
        progress: 20,
      }));

      if (abortRef.current) return;

      // --- Step 4: Initialize Barretenberg ---
      const { Barretenberg } = await import("@aztec/bb.js");
      const bb = await Barretenberg.new({ threads: 1 });

      // --- Step 5: Create provers ---
      const { SwapProver } = await import("@proof/swap-prover");
      const { SwapProofTree } = await import("@proof/swap-proof-tree");
      const { LotStateTree } = await import("@proof/lot-state-tree");
      const { TaxProver } = await import("@proof/tax-prover");
      const { Fr } = await import("@aztec/aztec.js/fields");
      const { PriceFeedContract } = await import(
        "@aztec/noir-contracts.js/PriceFeed"
      );

      const prover = new SwapProver({
        bb,
        circuit: individualSwapJson,
        recipientCompleteAddress: completeAddress,
        ivskM,
        node: wallet.getNode(),
      });

      const proofTree = new SwapProofTree({
        bb,
        leafCircuit: individualSwapJson,
        summaryCircuit: swapSummaryTreeJson,
        swapProver: prover,
      });

      // Initialize lot state tree with USDC lot from initial mint
      const lotStateTree = new LotStateTree();
      const usdcAddr = process.env.NEXT_PUBLIC_TOKEN_USDC;
      if (usdcAddr) {
        const usdcField = Fr.fromString(usdcAddr);
        // Initial USDC balance: 100,000 with 6 decimals
        await lotStateTree.setLots(
          usdcField,
          [{ amount: 100_000n * 10n ** 6n, costPerUnit: 10n }],
          1
        );
      }

      const priceFeedAddr = process.env.NEXT_PUBLIC_PRICE_FEED;
      const priceFeedAddress = priceFeedAddr
        ? Fr.fromString(priceFeedAddr)
        : Fr.ZERO;
      const priceFeedAssetsSlot = PriceFeedContract.storage.assets.slot;

      if (abortRef.current) return;

      // --- Step 6: Convert events to Buffer format ---
      const swapEvents = encryptedEvents.map((e) => ({
        encryptedLog: Buffer.from(e.ciphertext, "hex"),
        blockNumber: BigInt(e.blockNumber),
      }));

      // --- Step 7: Run proof pipeline ---
      setState((prev) => ({
        ...prev,
        status: "proving",
        statusText: `Proving swap 1/${totalSwaps}...`,
        progress: 25,
      }));

      const result = await proofTree.prove(
        swapEvents,
        lotStateTree,
        priceFeedAddress,
        priceFeedAssetsSlot,
        (step, current, total) => {
          if (abortRef.current) return;
          if (step === "swap") {
            const swapProgress = 25 + (current / total) * 45;
            const treeViz = buildTreeNodes(totalSwaps, current - 1, current - 1);
            setState((prev) => ({
              ...prev,
              status: "proving",
              currentSwap: current,
              statusText: `Proving swap ${current}/${total}...`,
              progress: Math.round(swapProgress),
              ...treeViz,
            }));
          } else if (step === "aggregate") {
            const aggProgress = 70 + (current / Math.max(total, 1)) * 15;
            const treeViz = buildTreeNodes(totalSwaps, totalSwaps, null);
            // Mark intermediates as proving during aggregation
            setState((prev) => ({
              ...prev,
              status: "aggregating",
              statusText: `Aggregating proofs (level ${current})...`,
              progress: Math.round(aggProgress),
              ...treeViz,
            }));
          }
        }
      );

      if (abortRef.current) return;

      // Mark all leaves verified
      const treeVizDone = buildTreeNodes(totalSwaps, totalSwaps, null);

      // --- Step 8: Tax proof ---
      setState((prev) => ({
        ...prev,
        status: "taxing",
        statusText: "Computing capital gains tax...",
        progress: 88,
        ...treeVizDone,
        treeRoot: { ...treeVizDone.treeRoot, status: "proving" },
      }));

      const taxProver = TaxProver.create(
        bb,
        swapSummaryTreeJson,
        capitalGainsTaxJson
      );
      const taxResult = await taxProver.prove(result);

      if (abortRef.current) return;

      // --- Step 9: Extract decoded swaps ---
      const decodedSwaps: DecodedSwap[] = result.swapData.map((sd) => ({
        tokenIn: sd.tokenIn,
        tokenOut: sd.tokenOut,
        amountIn: sd.amountIn,
        amountOut: sd.amountOut,
        blockNumber: sd.blockNumber,
      }));

      // Final tree: everything verified
      const finalTreeViz = buildTreeNodes(totalSwaps, totalSwaps, null);

      setState({
        status: "complete",
        totalEvents: totalSwaps,
        currentSwap: totalSwaps,
        totalSwaps,
        statusText: "Proof complete!",
        progress: 100,
        pnl: taxResult.publicInputs.pnl,
        tax: taxResult.publicInputs.tax,
        merkleRoot: taxResult.publicInputs.root,
        blockNumber: taxResult.publicInputs.blockNumber,
        proof: taxResult.proof,
        swaps: decodedSwaps,
        ...finalTreeViz,
        treeRoot: { ...finalTreeViz.treeRoot, status: "verified" },
        error: null,
      });

      // Cleanup
      bb.destroy();
    } catch (err: any) {
      console.error("Prove flow error:", err);
      setState((prev) => ({
        ...prev,
        status: "error",
        statusText: "Proof generation failed",
        error: err.message ?? "Unknown error",
      }));
    }
  }, [wallet, address]);

  const reset = useCallback(() => {
    abortRef.current = true;
    setState(makeInitialState());
  }, []);

  return {
    state,
    startProving,
    reset,
    resolveToken,
    formatAmount,
    formatPnl,
  };
}
