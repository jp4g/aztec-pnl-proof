"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";

// Next.js requires static process.env access for build-time replacement
export const TOKEN_ADDRESSES: Record<string, string | undefined> = {
  USDC: process.env.NEXT_PUBLIC_TOKEN_USDC,
  wETH: process.env.NEXT_PUBLIC_TOKEN_WETH,
  wZEC: process.env.NEXT_PUBLIC_TOKEN_WZEC,
  wAZTEC: process.env.NEXT_PUBLIC_TOKEN_WAZTEC,
};

export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  wETH: 9,
  wZEC: 9,
  wAZTEC: 9,
};

export function formatTokenBalance(raw: bigint, decimals: number): string {
  const value = Number(raw) / 10 ** decimals;
  const displayDecimals = decimals <= 6 ? 2 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: displayDecimals,
    maximumFractionDigits: displayDecimals,
  });
}

export function useTokenBalances() {
  const { wallet, address } = useAztecWallet();
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const pendingRef = useRef(new Set<string>());

  // Reset when address changes
  useEffect(() => {
    setBalances({});
    setLoading({});
    pendingRef.current.clear();
  }, [address]);

  const fetchBalance = useCallback(
    (symbol: string) => {
      if (!wallet || !address) return;
      // Build a per-address key so we don't skip fetches after address change
      const key = `${address}:${symbol}`;
      if (pendingRef.current.has(key)) return;
      pendingRef.current.add(key);

      const tokenAddr = TOKEN_ADDRESSES[symbol];
      if (!tokenAddr) return;

      setLoading((prev) => ({ ...prev, [symbol]: true }));

      // Use the wallet's IDB queue so balance fetches don't overlap with
      // contract registration or other PXE operations
      wallet.enqueue(async () => {
        try {
          const { AztecAddress } = await import("@aztec/aztec.js/addresses");
          const { Contract } = await import("@aztec/aztec.js/contracts");
          const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");

          const token = await Contract.at(
            AztecAddress.fromString(tokenAddr),
            TokenContractArtifact,
            wallet
          );
          const owner = AztecAddress.fromString(address);
          const result = await token.methods.balance_of_private(owner).simulate({ from: owner });
          const raw =
            typeof result === "bigint" ? result : BigInt(result.toString());
          const decimals = TOKEN_DECIMALS[symbol] ?? 18;
          const formatted = formatTokenBalance(raw, decimals);
          setBalances((prev) => ({ ...prev, [symbol]: formatted }));
        } catch (err) {
          console.warn(`Failed to fetch ${symbol} balance:`, err);
          setBalances((prev) => ({ ...prev, [symbol]: "0" }));
        } finally {
          setLoading((prev) => ({ ...prev, [symbol]: false }));
        }
      });
    },
    [wallet, address]
  );

  const getBalance = useCallback(
    (symbol: string): string | null => {
      if (!address) return null;
      return balances[symbol] ?? null;
    },
    [address, balances]
  );

  const isLoading = useCallback(
    (symbol: string): boolean => {
      return loading[symbol] ?? false;
    },
    [loading]
  );

  const setBalance = useCallback((symbol: string, formatted: string) => {
    setBalances((prev) => ({ ...prev, [symbol]: formatted }));
  }, []);

  const [refreshCounter, setRefreshCounter] = useState(0);

  const refreshAll = useCallback(() => {
    pendingRef.current.clear();
    setBalances({});
    setLoading({});
    setRefreshCounter((c) => c + 1);
  }, []);

  return { getBalance, isLoading, fetchBalance, refreshAll, setBalance, refreshCounter };
}
