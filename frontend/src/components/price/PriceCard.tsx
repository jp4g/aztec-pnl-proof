"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { TOKENS } from "@/data/dummy";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";
import ProgressBar from "@/components/ui/ProgressBar";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { TOKEN_ADDRESSES } from "@/hooks/useTokenBalances";
import { useToast } from "@/hooks/useToast";

const PRICE_PRECISION = 10_000;
const STORAGE_KEY = "privdex-price-assets";

const AVAILABLE_TOKENS = Object.entries(TOKENS)
  .filter(([sym]) => TOKEN_ADDRESSES[sym])
  .map(([symbol, token]) => ({ symbol, token: token as Token }));

const POOL_DEFS = [
  { label: "wETH/USDC", token0: "wETH", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_ETH_USDC },
  { label: "wZEC/USDC", token0: "wZEC", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_ZEC_USDC },
  { label: "wAZTEC/USDC", token0: "wAZTEC", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_AZTEC_USDC },
];

interface TokenPriceRow {
  symbol: string;
  currentPrice: string;
  newPrice: string;
  loading: boolean;
}

function formatUsd(value: number): string {
  if (value >= 1) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function isValidPrice(value: string): boolean {
  if (value === "") return true;
  return /^\d*\.?\d*$/.test(value) && !(value.startsWith("0") && value.length > 1 && value[1] !== ".");
}

export default function PriceCard() {
  const { wallet, address, status: walletStatus, isDemoAccount } = useAztecWallet();
  const { showToast } = useToast();
  const isDemo = walletStatus === "connected" && address ? isDemoAccount(address) : false;

  const [rows, setRows] = useState<TokenPriceRow[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const symbols: string[] = JSON.parse(saved);
        return symbols
          .filter((s) => AVAILABLE_TOKENS.some((t) => t.symbol === s))
          .map((symbol) => ({ symbol, currentPrice: "", newPrice: "", loading: false }));
      }
    } catch {}
    return [];
  });
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ step: 0, total: 0, label: "" });
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const adminRef = useRef<import("@aztec/aztec.js/addresses").AztecAddress | null>(null);
  const adminRegistering = useRef(false);
  const fetchedRef = useRef(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const connected = walletStatus === "connected";

  const ensureAdmin = useCallback(async () => {
    if (adminRef.current || !wallet) return;
    if (adminRegistering.current) {
      // Wait for ongoing registration
      while (adminRegistering.current) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }
    adminRegistering.current = true;
    try {
      const { getInitialTestAccountsData } = await import("@aztec/accounts/testing");
      const testAccounts = await getInitialTestAccountsData();
      const admin = testAccounts[0];
      adminRef.current = await wallet.registerAccountFromCredentials(
        admin.secret,
        admin.salt,
        admin.signingKey
      );
    } catch (err) {
      console.warn("Failed to register admin account:", err);
    } finally {
      adminRegistering.current = false;
    }
  }, [wallet]);

  const fetchPrices = useCallback(async () => {
    if (!wallet || !address) return;

    setRows((prev) => prev.map((r) => ({ ...r, loading: true })));

    try {
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { PriceFeedContractArtifact } = await import("@aztec/noir-contracts.js/PriceFeed");

      const pfAddr = process.env.NEXT_PUBLIC_PRICE_FEED;
      if (!pfAddr) throw new Error("NEXT_PUBLIC_PRICE_FEED not set");

      const priceFeed = await Contract.at(
        AztecAddress.fromString(pfAddr),
        PriceFeedContractArtifact,
        wallet
      );
      const owner = AztecAddress.fromString(address);

      const currentSymbols = rowsRef.current.map((r) => r.symbol);
      for (const symbol of currentSymbols) {
        const tokenAddrStr = TOKEN_ADDRESSES[symbol];
        if (!tokenAddrStr) continue;

        try {
          const tokenAddr = AztecAddress.fromString(tokenAddrStr);
          const result = await priceFeed.methods
            .get_price(tokenAddr.toField())
            .simulate({ from: owner });

          // result is Asset { price: u128 } which serializes as 1 Field
          const raw = typeof result === "object" && result !== null
            ? (typeof result.price !== "undefined" ? BigInt(result.price.toString()) : BigInt(result.toString()))
            : BigInt(result.toString());
          const usdPrice = Number(raw) / PRICE_PRECISION;
          const priceStr = usdPrice.toString();

          setRows((prev) =>
            prev.map((r) =>
              r.symbol === symbol
                ? { ...r, currentPrice: priceStr, newPrice: priceStr, loading: false }
                : r
            )
          );
        } catch (err) {
          console.warn(`Failed to fetch price for ${symbol}:`, err);
          setRows((prev) =>
            prev.map((r) => (r.symbol === symbol ? { ...r, loading: false } : r))
          );
        }
      }
    } catch (err) {
      console.error("Failed to initialize PriceFeed contract:", err);
      setRows((prev) => prev.map((r) => ({ ...r, loading: false })));
    }
  }, [wallet, address]);

  // Fetch prices on mount when connected
  useEffect(() => {
    if (connected && wallet && !fetchedRef.current) {
      fetchedRef.current = true;
      wallet.enqueue(() => fetchPrices());
    }
  }, [connected, wallet, fetchPrices]);

  // Reset on disconnect
  useEffect(() => {
    if (!connected) {
      fetchedRef.current = false;
      setRows((prev) =>
        prev.map((r) => ({ ...r, currentPrice: "", newPrice: "", loading: false }))
      );
    }
  }, [connected]);

  const handlePriceChange = useCallback((symbol: string, value: string) => {
    if (!isValidPrice(value)) return;
    setRows((prev) =>
      prev.map((r) => (r.symbol === symbol ? { ...r, newPrice: value } : r))
    );
  }, []);

  const persistSymbols = useCallback((nextRows: TokenPriceRow[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRows.map((r) => r.symbol)));
    } catch {}
  }, []);

  const addToken = useCallback(
    (symbol: string) => {
      setRows((prev) => {
        if (prev.some((r) => r.symbol === symbol)) return prev;
        const next = [...prev, { symbol, currentPrice: "", newPrice: "", loading: false }];
        persistSymbols(next);
        return next;
      });
      setShowSearch(false);
      setSearchQuery("");
      // Fetch price for newly added token if connected
      if (wallet && connected) {
        fetchedRef.current = false;
        wallet.enqueue(() => fetchPrices());
      }
    },
    [wallet, connected, fetchPrices, persistSymbols]
  );

  const removeToken = useCallback(
    (symbol: string) => {
      setRows((prev) => {
        const next = prev.filter((r) => r.symbol !== symbol);
        persistSymbols(next);
        return next;
      });
    },
    [persistSymbols]
  );

  // Close search dropdown when clicking outside
  useEffect(() => {
    if (!showSearch) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSearch]);

  const addedSymbols = new Set(rows.map((r) => r.symbol));
  const filteredAvailable = AVAILABLE_TOKENS.filter(
    (t) => !addedSymbols.has(t.symbol) && t.symbol.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const changedTokens = rows.filter(
    (r) => r.currentPrice !== "" && r.newPrice !== "" && r.newPrice !== r.currentPrice
  );

  const affectedPools = POOL_DEFS.filter((pool) =>
    changedTokens.some((t) => t.symbol === pool.token0 || t.symbol === pool.token1)
  );

  const handleApply = useCallback(async () => {
    if (!wallet || !address || executing) return;
    if (changedTokens.length === 0) return;

    setExecuting(true);
    const totalSteps = changedTokens.length + affectedPools.length;
    let currentStep = 0;

    try {
      // Ensure admin is registered
      setProgress({ step: 0, total: totalSteps, label: "Registering admin..." });
      await ensureAdmin();
      if (!adminRef.current) throw new Error("Admin account not available");

      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { PriceFeedContractArtifact } = await import("@aztec/noir-contracts.js/PriceFeed");
      const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");

      const pfAddr = process.env.NEXT_PUBLIC_PRICE_FEED;
      if (!pfAddr) throw new Error("NEXT_PUBLIC_PRICE_FEED not set");

      const priceFeed = await Contract.at(
        AztecAddress.fromString(pfAddr),
        PriceFeedContractArtifact,
        wallet
      );

      // Build price map: symbol -> oracle price (bigint, with precision)
      const priceMap = new Map<string, bigint>();
      for (const row of rows) {
        const price = parseFloat(row.newPrice || row.currentPrice);
        if (!isNaN(price)) {
          priceMap.set(row.symbol, BigInt(Math.round(price * PRICE_PRECISION)));
        }
      }

      // 1. Set oracle prices for changed tokens
      for (const changed of changedTokens) {
        currentStep++;
        setProgress({ step: currentStep, total: totalSteps, label: `Setting ${changed.symbol} price...` });

        const tokenAddrStr = TOKEN_ADDRESSES[changed.symbol];
        if (!tokenAddrStr) continue;

        const tokenAddr = AztecAddress.fromString(tokenAddrStr);
        const oraclePrice = priceMap.get(changed.symbol)!;

        await priceFeed.methods
          .set_price(tokenAddr.toField(), oraclePrice)
          .send({ from: adminRef.current });
      }

      // 2. Rebalance affected pools
      for (const pool of affectedPools) {
        currentStep++;
        setProgress({ step: currentStep, total: totalSteps, label: `Rebalancing ${pool.label}...` });

        if (!pool.address) continue;

        const poolAddr = AztecAddress.fromString(pool.address);
        const token0AddrStr = TOKEN_ADDRESSES[pool.token0];
        const token1AddrStr = TOKEN_ADDRESSES[pool.token1];
        if (!token0AddrStr || !token1AddrStr) continue;

        const token0Addr = AztecAddress.fromString(token0AddrStr);
        const token1Addr = AztecAddress.fromString(token1AddrStr);

        const token0Contract = await Contract.at(token0Addr, TokenContractArtifact, wallet);
        const token1Contract = await Contract.at(token1Addr, TokenContractArtifact, wallet);

        const owner = AztecAddress.fromString(address);
        const [reserve0Raw, reserve1Raw] = await Promise.all([
          token0Contract.methods.balance_of_public(poolAddr).simulate({ from: owner }),
          token1Contract.methods.balance_of_public(poolAddr).simulate({ from: owner }),
        ]);

        const reserve0 = typeof reserve0Raw === "bigint" ? reserve0Raw : BigInt(reserve0Raw.toString());
        const reserve1 = typeof reserve1Raw === "bigint" ? reserve1Raw : BigInt(reserve1Raw.toString());

        const p0 = priceMap.get(pool.token0);
        const p1 = priceMap.get(pool.token1);
        if (p0 === undefined || p1 === undefined) continue;

        const value0 = reserve0 * p0;
        const value1 = reserve1 * p1;

        if (value0 > value1 && p1 > BigInt(0)) {
          // Mint token1 to balance
          const targetR1 = reserve0 * p0 / p1;
          const toMint = targetR1 - reserve1;
          if (toMint > BigInt(0)) {
            await token1Contract.methods
              .mint_to_public(poolAddr, toMint)
              .send({ from: adminRef.current });
          }
        } else if (value1 > value0 && p0 > BigInt(0)) {
          // Mint token0 to balance
          const targetR0 = reserve1 * p1 / p0;
          const toMint = targetR0 - reserve0;
          if (toMint > BigInt(0)) {
            await token0Contract.methods
              .mint_to_public(poolAddr, toMint)
              .send({ from: adminRef.current });
          }
        }
      }

      // Update current prices to new prices
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          currentPrice: r.newPrice || r.currentPrice,
        }))
      );

      showToast("Prices updated and pools rebalanced", "success");
    } catch (err) {
      console.error("Apply & Rebalance failed:", err);
      const msg = err instanceof Error ? err.message : "Failed to apply changes";
      showToast(msg, "error");
    } finally {
      setExecuting(false);
      setProgress({ step: 0, total: 0, label: "" });
    }
  }, [wallet, address, executing, changedTokens, affectedPools, rows, ensureAdmin, showToast]);

  const handleRefresh = useCallback(() => {
    if (!wallet || !connected) return;
    fetchedRef.current = false;
    wallet.enqueue(() => fetchPrices());
  }, [wallet, connected, fetchPrices]);

  // Button state
  let buttonLabel = "Apply & Rebalance";
  let buttonDisabled = false;
  if (!connected) {
    buttonLabel = "Connect Wallet";
    buttonDisabled = true;
  } else if (isDemo) {
    buttonLabel = "Demo Account";
    buttonDisabled = true;
  } else if (changedTokens.length === 0) {
    buttonLabel = "No price changes";
    buttonDisabled = true;
  } else if (executing) {
    buttonLabel = "Executing...";
    buttonDisabled = true;
  }

  const progressPercent = progress.total > 0 ? Math.round((progress.step / progress.total) * 100) : 0;

  return (
    <div className="w-full max-w-md bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
      {isDemo && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-700">
          Changing demo account state is restricted — make a new account to create a PnL proof with live data!
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-neutral-900">Set Oracle Prices</h2>
        {connected && (
          <button
            onClick={handleRefresh}
            disabled={executing}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-neutral-100 text-neutral-500 transition-colors disabled:opacity-50"
          >
            <Icon icon="lucide:refresh-cw" width={16} />
          </button>
        )}
      </div>

      {/* Token rows */}
      <div className="space-y-2">
        {rows.length === 0 && (
          <div className="text-center py-6 text-sm text-neutral-400">
            Add tokens to set their oracle prices
          </div>
        )}
        {rows.map((row) => {
          const tokenDef = AVAILABLE_TOKENS.find((t) => t.symbol === row.symbol);
          const isChanged = row.currentPrice !== "" && row.newPrice !== "" && row.newPrice !== row.currentPrice;

          return (
            <div
              key={row.symbol}
              className="flex items-center gap-3 rounded-xl bg-neutral-50 border border-neutral-100 px-4 py-3"
            >
              {tokenDef && <TokenIcon token={tokenDef.token} size="sm" />}
              <span className="text-sm font-medium text-neutral-800 w-16">{row.symbol}</span>
              <span className="text-xs text-neutral-400 flex-shrink-0">
                {row.loading ? (
                  <span className="inline-block w-3 h-3 border border-neutral-300 border-t-transparent rounded-full animate-spin align-middle" />
                ) : row.currentPrice ? (
                  `$${formatUsd(parseFloat(row.currentPrice))}`
                ) : (
                  "--"
                )}
              </span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={row.newPrice}
                onChange={(e) => handlePriceChange(row.symbol, e.target.value)}
                disabled={!connected || executing || isDemo}
                className="flex-1 text-right text-sm font-mono bg-white border border-neutral-200 rounded-lg px-2 py-1.5 outline-none focus:border-orange-400 disabled:bg-neutral-100 disabled:text-neutral-400"
              />
              {isChanged && (
                <span className="text-orange-500 text-sm font-bold flex-shrink-0">*</span>
              )}
              {!executing && (
                <button
                  onClick={() => removeToken(row.symbol)}
                  className="w-5 h-5 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 hover:bg-neutral-200 transition-colors flex-shrink-0"
                >
                  <Icon icon="lucide:x" width={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Asset */}
      {!executing && addedSymbols.size < AVAILABLE_TOKENS.length && (
        <div className="relative mt-2" ref={searchRef}>
          <button
            onClick={() => setShowSearch((v) => !v)}
            className="w-full py-2 rounded-xl border border-dashed border-neutral-300 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors flex items-center justify-center gap-1.5"
          >
            <Icon icon="lucide:plus" width={14} />
            Add Asset
          </button>
          {showSearch && (
            <div className="absolute left-0 right-0 mt-1 bg-white border border-neutral-200 rounded-xl shadow-lg z-10 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-100">
                <Icon icon="lucide:search" width={14} className="text-neutral-400" />
                <input
                  type="text"
                  placeholder="Search tokens..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                  className="flex-1 text-sm outline-none bg-transparent placeholder:text-neutral-400"
                />
              </div>
              <div className="max-h-40 overflow-y-auto">
                {filteredAvailable.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-neutral-400">No matches</div>
                ) : (
                  filteredAvailable.map((t) => (
                    <button
                      key={t.symbol}
                      onClick={() => addToken(t.symbol)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-neutral-50 transition-colors"
                    >
                      <TokenIcon token={t.token} size="sm" />
                      <span className="text-sm font-medium text-neutral-800">{t.symbol}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Changes preview */}
      {changedTokens.length > 0 && !executing && (
        <div className="mt-4 px-1">
          <span className="text-xs text-neutral-500 font-medium">Changes:</span>
          <div className="mt-1 space-y-0.5">
            {changedTokens.map((t) => (
              <div key={t.symbol} className="text-xs text-neutral-600">
                {t.symbol}: ${formatUsd(parseFloat(t.currentPrice))} &rarr; ${formatUsd(parseFloat(t.newPrice))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress */}
      {executing && progress.total > 0 && (
        <div className="mt-4 space-y-2">
          <ProgressBar progress={progressPercent} />
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-500">{progress.label}</span>
            <span className="text-xs text-neutral-400 font-mono">{progressPercent}%</span>
          </div>
        </div>
      )}

      {/* Action button */}
      <button
        onClick={handleApply}
        disabled={buttonDisabled}
        className="mt-4 w-full py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:bg-neutral-100 disabled:text-neutral-400 disabled:cursor-not-allowed bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700"
      >
        {executing && (
          <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        )}
        {buttonLabel}
      </button>
    </div>
  );
}
