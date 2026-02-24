"use client";

console.log("[prove] useProveFlow MODULE LOADED");

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

/**
 * Build tree visualization nodes.
 * @param totalLeaves - number of real swap leaves
 * @param provenCount - how many leaf proofs are done
 * @param currentProving - index of leaf currently being proven (null if not proving a leaf)
 * @param aggregationLevel - how far aggregation has progressed:
 *   0 = no aggregation yet (only leaves), 1 = L2 intermediates done,
 *   2 = L1 intermediates done, 3 = root done
 */
function buildTreeNodes(
  totalLeaves: number,
  provenCount: number,
  currentProving: number | null,
  aggregationLevel = 0,
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
    const bothUnused = leaves[i * 2].status === "unused" && leaves[i * 2 + 1].status === "unused";
    let status: TreeNodeStatus;
    if (bothUnused) status = "unused";
    else if (aggregationLevel >= 1) status = "verified";
    else status = "pending";
    intermediatesL2.push({ id: `int-2-${i}`, status });
  }

  // Level 1 intermediates (padded/4 nodes)
  const l1Count = padded / 4;
  const intermediatesL1: TreeNode[] = [];
  for (let i = 0; i < l1Count; i++) {
    const bothUnused = intermediatesL2[i * 2]?.status === "unused" && (intermediatesL2[i * 2 + 1]?.status === "unused" || !intermediatesL2[i * 2 + 1]);
    let status: TreeNodeStatus;
    if (bothUnused) status = "unused";
    else if (aggregationLevel >= 2) status = "verified";
    else status = "pending";
    intermediatesL1.push({ id: `int-1-${i}`, status });
  }

  // Root
  const root: TreeNode = {
    id: "root",
    status: aggregationLevel >= 3 ? "verified" : "pending",
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
    console.log("[prove] startProving CALLED, wallet:", !!wallet, "address:", address);
    if (!wallet || !address) return;
    abortRef.current = false;

    setState({
      ...makeInitialState(),
      status: "discovering",
      statusText: "Discovering encrypted swap events...",
      progress: 5,
    });

    try {
      console.log("[prove] === Starting prove flow ===");
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

      // Decrypt all events upfront to populate the transaction table
      setState((prev) => ({
        ...prev,
        statusText: `Found ${totalSwaps} events. Decrypting...`,
        progress: 12,
      }));

      const { decryptLog } = await import("@proof/decrypt");
      const decodedSwaps: DecodedSwap[] = [];
      for (const evt of encryptedEvents) {
        const plaintext = await decryptLog(
          Buffer.from(evt.ciphertext, "hex"),
          completeAddress,
          ivskM,
        );
        if (plaintext) {
          decodedSwaps.push({
            tokenIn: plaintext[2].toString(),
            tokenOut: plaintext[3].toString(),
            amountIn: plaintext[4].toBigInt(),
            amountOut: plaintext[5].toBigInt(),
            blockNumber: BigInt(evt.blockNumber),
          });
        }
      }

      // Build initial tree visualization
      const treeViz = buildTreeNodes(totalSwaps, 0, null);

      setState((prev) => ({
        ...prev,
        totalEvents: totalSwaps,
        totalSwaps,
        swaps: decodedSwaps,
        statusText: `Found ${totalSwaps} swap events. Loading circuits...`,
        progress: 15,
        ...treeViz,
      }));

      if (abortRef.current) return;

      // --- Step 3: Load circuit artifacts + precomputed vkeys ---
      console.log("[prove] Step 3a: fetching circuits...");
      const [individualSwapJson, swapSummaryTreeJson, capitalGainsTaxJson, vkeysJson] =
        await Promise.all([
          fetch("/circuits/individual_swap.json").then((r) => r.json()),
          fetch("/circuits/swap_summary_tree.json").then((r) => r.json()),
          fetch("/circuits/capital_gains_tax.json").then((r) => r.json()),
          fetch("/circuits/vkeys.json").then((r) => r.json()),
        ]);
      console.log("[prove] Step 3b: circuits loaded, vkeys leaf hash:", vkeysJson?.leaf?.vkHash);

      setState((prev) => ({
        ...prev,
        statusText: "Initializing proof engine...",
        progress: 20,
      }));

      if (abortRef.current) return;

      // --- Step 4: Initialize Barretenberg ---
      console.log("[prove] Step 4a: importing bb.js...");
      const { Barretenberg } = await import("@aztec/bb.js");
      console.log("[prove] Step 4b: creating Barretenberg...");
      const bb = await Barretenberg.new({ threads: 1 });
      console.log("[prove] Step 4c: loading larger CRS...");
      // Summary circuit (recursive proof verification) needs > 2^20 CRS points
      await bb.initSRSChonk(2 ** 21);
      console.log("[prove] Step 4d: CRS loaded");

      // --- Step 5: Create provers ---
      console.log("[prove] Step 5: Creating provers...");
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
        summaryCircuit: swapSummaryTreeJson,
        swapProver: prover,
        vkeys: vkeysJson,
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
      console.log("[prove] Step 6: Converting events...");
      const swapEvents = encryptedEvents.map((e) => ({
        encryptedLog: Buffer.from(e.ciphertext, "hex"),
        blockNumber: BigInt(e.blockNumber),
      }));

      // --- Step 7: Run proof pipeline ---
      console.log("[prove] Step 7: Starting proof pipeline...");
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
            const treeViz = buildTreeNodes(totalSwaps, totalSwaps, null, current);
            setState((prev) => ({
              ...prev,
              status: "aggregating",
              statusText: `Aggregating proofs (level ${current}/${total})...`,
              progress: Math.round(aggProgress),
              ...treeViz,
            }));
          }
        }
      );

      if (abortRef.current) return;

      // --- Step 8: Tax proof ---
      // All aggregation levels done, root is now being proven (tax wraps it)
      const treeVizTax = buildTreeNodes(totalSwaps, totalSwaps, null, 3);
      setState((prev) => ({
        ...prev,
        status: "taxing",
        statusText: "Computing capital gains tax...",
        progress: 88,
        ...treeVizTax,
        treeRoot: { ...treeVizTax.treeRoot, status: "proving" },
      }));

      const taxProver = new TaxProver(
        bb,
        capitalGainsTaxJson,
        vkeysJson.summary
      );
      const taxResult = await taxProver.prove(result);

      if (abortRef.current) return;

      // Final tree: everything verified (aggregation level 3 = all done)
      const finalTreeViz = buildTreeNodes(totalSwaps, totalSwaps, null, 3);

      setState((prev) => ({
        ...prev,
        status: "complete",
        currentSwap: totalSwaps,
        statusText: "Proof complete!",
        progress: 100,
        pnl: taxResult.publicInputs.pnl,
        tax: taxResult.publicInputs.tax,
        merkleRoot: taxResult.publicInputs.root,
        blockNumber: taxResult.publicInputs.blockNumber,
        proof: taxResult.proof,
        ...finalTreeViz,
        error: null,
      }));

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
