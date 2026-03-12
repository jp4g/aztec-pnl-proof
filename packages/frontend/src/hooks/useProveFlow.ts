"use client";

import { useState, useCallback, useRef } from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import type {
  ProveFlowState,
  DecodedSwap,
  DownloadableProof,
} from "@/types";
import { TOKENS } from "@/config/tokens";
import { buildTreeNodes } from "@/lib/tree-utils";

/** Map token contract addresses to symbols for display.
 *  Next.js requires literal `process.env.NEXT_PUBLIC_*` for static replacement —
 *  bracket notation like `process.env[varName]` silently returns undefined. */
const TOKEN_ADDRESS_MAP: Record<string, { symbol: string; color: string }> = {};

function initTokenAddressMap() {
  const entries: [string | undefined, keyof typeof TOKENS][] = [
    [process.env.NEXT_PUBLIC_TOKEN_USDC, "USDC"],
    [process.env.NEXT_PUBLIC_TOKEN_WETH, "wETH"],
    [process.env.NEXT_PUBLIC_TOKEN_WZEC, "wZEC"],
    [process.env.NEXT_PUBLIC_TOKEN_WAZTEC, "wAZTEC"],
  ];
  for (const [addr, symbol] of entries) {
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

// PnL raw units = token_amount (TOKEN_DECIMALS=9) * oracle_price_diff (PRICE_PRECISION=10,000)
// Divide by 10^(9+4) = 10^13 to get USD
const PNL_DIVISOR = 10n ** 13n;

function formatPnl(pnl: bigint): string {
  const sign = pnl >= 0n ? "+" : "-";
  const abs = pnl < 0n ? -pnl : pnl;
  const whole = abs / PNL_DIVISOR;
  const frac = (abs % PNL_DIVISOR).toString().padStart(13, "0").slice(0, 2);
  return `${sign}$${whole.toLocaleString()}.${frac}`;
}

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
    pnlProof: null,
    taxProof: null,
    swaps: [],
    treeLevels: [],
    error: null,
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

      // Decrypt all events upfront to populate the transaction table
      setState((prev) => ({
        ...prev,
        statusText: `Found ${totalSwaps} events. Decrypting...`,
        progress: 12,
      }));

      const { decryptLog } = await import("@privpnl/proof/decrypt");
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
      const [individualSwapJson, swapSummaryTreeJson, capitalGainsTaxJson, vkeysJson] =
        await Promise.all([
          fetch("/circuits/individual_swap.json").then((r) => r.json()),
          fetch("/circuits/swap_summary_tree.json").then((r) => r.json()),
          fetch("/circuits/capital_gains_tax.json").then((r) => r.json()),
          fetch("/circuits/vkeys.json").then((r) => r.json()),
        ]);
      setState((prev) => ({
        ...prev,
        statusText: "Initializing proof engine...",
        progress: 20,
      }));

      if (abortRef.current) return;

      // --- Step 4: Initialize Barretenberg ---
      const { Barretenberg } = await import("@aztec/bb.js");
      const numThreads = navigator.hardwareConcurrency || 1;
      const bb = await Barretenberg.new({ threads: numThreads });
      // Summary circuit (recursive proof verification) needs > 2^20 CRS points
      await bb.initSRSChonk(2 ** 21);

      // --- Step 5: Create provers ---
      const { SwapProver } = await import("@privpnl/proof/swap-prover");
      const { LotStateTree } = await import("@privpnl/proof/lot-state-tree");
      const { Fr } = await import("@aztec/aztec.js/fields");
      const { PriceFeedContract } = await import(
        "@aztec/noir-contracts.js/PriceFeed"
      );

      const archivalNodeUrl = process.env.NEXT_PUBLIC_AZTEC_ARCHIVAL_NODE_URL;
      let archivalNode;
      if (archivalNodeUrl) {
        const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
        archivalNode = createAztecNodeClient(archivalNodeUrl);
      }

      const prover = new SwapProver({
        bb,
        circuit: individualSwapJson,
        recipientCompleteAddress: completeAddress,
        ivskM,
        node: wallet.getNode(),
        archivalNode,
      });

      // Initialize lot state tree with USDC lot from initial mint
      const lotStateTree = new LotStateTree();
      const usdcAddr = process.env.NEXT_PUBLIC_TOKEN_USDC;
      if (usdcAddr) {
        const usdcField = Fr.fromString(usdcAddr);
        await lotStateTree.setLots(
          usdcField,
          [{ amount: 100_000n * 10n ** 6n, costPerUnit: 10_000n }],
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

      // --- Step 7: Full SwapProofTree + Tax ---
      setState((prev) => ({
        ...prev,
        status: "proving",
        statusText: `Proving swap 1/${totalSwaps}...`,
        progress: 25,
      }));

      const { SwapProofTree } = await import("@privpnl/proof/swap-proof-tree");
      const { TaxProver } = await import("@privpnl/proof/tax-prover");

      const proofTree = new SwapProofTree({
        bb,
        summaryCircuit: swapSummaryTreeJson,
        swapProver: prover,
        vkeys: vkeysJson,
      });

      const result = await proofTree.prove(
        swapEvents,
        lotStateTree,
        priceFeedAddress,
        priceFeedAssetsSlot,
        (step, current, total, detail) => {
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
          } else if (step === "aggregate" && detail) {
            const aggProgress = 70 + ((current + 1) / Math.max(total, 1)) * 15;
            const treeViz = buildTreeNodes(totalSwaps, totalSwaps, null, {
              level: detail.level,
              nodeIndex: detail.nodeIndex,
            });
            setState((prev) => ({
              ...prev,
              status: "aggregating",
              statusText: `Aggregating proofs (level ${detail.level + 1}, node ${detail.nodeIndex + 1}/${detail.nodesInLevel})...`,
              progress: Math.round(aggProgress),
              ...treeViz,
            }));
          }
        }
      );

      if (abortRef.current) return;

      // Build downloadable PnL proof
      const pnlProof: DownloadableProof = {
        type: "pnl",
        proof: "0x" + Buffer.from(result.proof).toString("hex"),
        publicInputs: {
          root: result.publicInputs.root,
          pnl: result.publicInputs.pnl.toString(),
          remainingLotStateRoot: result.publicInputs.remainingLotStateRoot,
          initialLotStateRoot: result.publicInputs.initialLotStateRoot,
          priceFeedAddress: result.publicInputs.priceFeedAddress,
          blockNumber: result.publicInputs.blockNumber.toString(),
        },
      };

      // --- Tax proof ---
      const treeVizTax = buildTreeNodes(totalSwaps, totalSwaps, null, "complete");
      // Set root node to "proving" during tax computation
      const taxLevels = [...treeVizTax.treeLevels];
      const rootLevel = taxLevels[taxLevels.length - 1];
      taxLevels[taxLevels.length - 1] = [{ ...rootLevel[0], status: "proving" }];
      setState((prev) => ({
        ...prev,
        status: "taxing",
        statusText: "Computing capital gains tax...",
        progress: 88,
        treeLevels: taxLevels,
      }));

      const taxProver = new TaxProver(
        bb,
        capitalGainsTaxJson,
        vkeysJson.summary
      );
      const taxResult = await taxProver.prove(result);

      if (abortRef.current) return;

      // Build downloadable tax proof
      const taxProof: DownloadableProof = {
        type: "tax",
        proof: "0x" + Buffer.from(taxResult.proof).toString("hex"),
        publicInputs: {
          root: taxResult.publicInputs.root,
          pnl: taxResult.publicInputs.pnl.toString(),
          tax: taxResult.publicInputs.tax.toString(),
          remainingLotStateRoot: taxResult.publicInputs.remainingLotStateRoot,
          initialLotStateRoot: taxResult.publicInputs.initialLotStateRoot,
          priceFeedAddress: taxResult.publicInputs.priceFeedAddress,
          blockNumber: taxResult.publicInputs.blockNumber.toString(),
        },
      };

      const finalTreeViz = buildTreeNodes(totalSwaps, totalSwaps, null, "complete");
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
        pnlProof,
        taxProof,
        ...finalTreeViz,
        error: null,
      }));

      bb.destroy();
    } catch (err: any) {
      console.error("Prove flow error:", err);
      setState((prev) => ({
        ...prev,
        status: "error",
        statusText: `Error: ${err.message ?? err}`,
        error: err.message ?? String(err),
      }));
    }
  }, [wallet, address]);

  const reset = useCallback(() => {
    abortRef.current = true;
    setState(makeInitialState());
  }, []);

  const downloadProof = useCallback((type: "pnl" | "tax") => {
    const proof = type === "pnl" ? state.pnlProof : state.taxProof;
    if (!proof) return;
    const json = JSON.stringify(proof, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}-proof.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.pnlProof, state.taxProof]);

  return {
    state,
    startProving,
    reset,
    downloadProof,
    resolveToken,
    formatAmount,
    formatPnl,
  };
}
