"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Icon } from "@iconify/react";
import ProgressBar from "@/components/ui/ProgressBar";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useAdminAccount } from "@/hooks/useAdminAccount";
import { TOKEN_ADDRESSES, TOKEN_DECIMALS, DEFAULT_TOKEN_DECIMALS, POOL_DEFS } from "@/config/contracts";
import { rebalancePools, type PoolState, type TokenPrice } from "@privpnl/proof/rebalance";
import { useToast } from "@/hooks/useToast";
import { PRICE_PRECISION } from "@privpnl/proof/constants";
import { buildSponsoredFeePaymentMethod } from "@/lib/fee-utils";
import PriceRowList, {
  AVAILABLE_TOKENS,
  isValidPrice,
  type TokenPriceRow,
} from "./PriceRowList";
import AddAssetSearch from "./AddAssetSearch";
import ChangesPreview from "./ChangesPreview";

const STORAGE_KEY = "privpnl-price-assets";

export default function PriceCard() {
  const { wallet, address, status: walletStatus, isDemoAccount } = useAztecWallet();
  const { showToast } = useToast();
  const { adminRef, ensureAdmin } = useAdminAccount(wallet);
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

  const fetchedRef = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const connected = walletStatus === "connected";

  const fetchPrices = useCallback(async () => {
    if (!wallet || !address) return;

    setRows((prev) => prev.map((r) => ({ ...r, loading: true })));

    try {
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { PriceFeedContractArtifact } = await import("@privpnl/contracts/PriceFeed");

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
          const { result: asset } = await priceFeed.methods
            .get_price(tokenAddr.toField())
            .simulate({ from: owner });

          // asset is Asset { price: u128 }
          const raw = typeof asset === "object" && asset !== null
            ? (typeof asset.price !== "undefined" ? BigInt(asset.price.toString()) : BigInt(asset.toString()))
            : BigInt(asset.toString());
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

  const addedSymbols = useMemo(() => new Set(rows.map((r) => r.symbol)), [rows]);

  const changedTokens = useMemo(
    () => rows.filter(
      (r) => r.currentPrice !== "" && r.newPrice !== "" && r.newPrice !== r.currentPrice
    ),
    [rows],
  );

  const affectedPools = useMemo(
    () => POOL_DEFS.filter((pool) =>
      changedTokens.some((t) => t.symbol === pool.token0 || t.symbol === pool.token1)
    ),
    [changedTokens],
  );

  const handleApply = useCallback(async () => {
    if (!wallet || !address || executing) return;
    if (changedTokens.length === 0) return;

    setExecuting(true);

    try {
      // Ensure admin is registered
      setProgress({ step: 0, total: 1, label: "Registering admin..." });
      const admin = await ensureAdmin();
      if (!admin) throw new Error("Admin account not available");

      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { PriceFeedContractArtifact } = await import("@privpnl/contracts/PriceFeed");
      const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");

      const pfAddr = process.env.NEXT_PUBLIC_PRICE_FEED;
      if (!pfAddr) throw new Error("NEXT_PUBLIC_PRICE_FEED not set");

      const priceFeed = await Contract.at(
        AztecAddress.fromString(pfAddr),
        PriceFeedContractArtifact,
        wallet
      );

      // Build token prices for all tokens (including USDC which isn't in rows)
      const tokenPrices: TokenPrice[] = [];
      const priceBySymbol = new Map<string, number>();
      for (const row of rows) {
        const price = parseFloat(row.newPrice || row.currentPrice);
        if (!isNaN(price)) priceBySymbol.set(row.symbol, price);
      }
      // USDC is always $1
      priceBySymbol.set("USDC", 1.0);

      for (const [symbol, price] of priceBySymbol) {
        const addrStr = TOKEN_ADDRESSES[symbol];
        if (!addrStr) continue;
        const addr = AztecAddress.fromString(addrStr);
        tokenPrices.push({
          token: { address: addr } as TokenPrice["token"],
          price: BigInt(Math.round(price * PRICE_PRECISION)),
        });
      }

      // Build token labels for progress display
      const tokenLabels = new Map<string, string>();
      for (const [symbol, addr] of Object.entries(TOKEN_ADDRESSES)) {
        if (addr) tokenLabels.set(addr, symbol);
      }

      const poolStates: PoolState[] = [];
      for (const pool of affectedPools) {
        if (!pool.address) continue;
        const poolAddr = AztecAddress.fromString(pool.address);
        const token0AddrStr = TOKEN_ADDRESSES[pool.token0];
        const token1AddrStr = TOKEN_ADDRESSES[pool.token1];
        if (!token0AddrStr || !token1AddrStr) continue;

        const token0Contract = await Contract.at(
          AztecAddress.fromString(token0AddrStr), TokenContractArtifact, wallet
        );
        const token1Contract = await Contract.at(
          AztecAddress.fromString(token1AddrStr), TokenContractArtifact, wallet
        );

        const owner = AztecAddress.fromString(address);
        const [{ result: reserve0Raw }, { result: reserve1Raw }] = await Promise.all([
          token0Contract.methods.balance_of_public(poolAddr).simulate({ from: owner }),
          token1Contract.methods.balance_of_public(poolAddr).simulate({ from: owner }),
        ]);

        poolStates.push({
          contract: { address: poolAddr } as PoolState["contract"],
          token0: token0Contract as unknown as PoolState["token0"],
          token1: token1Contract as unknown as PoolState["token1"],
          reserve0: typeof reserve0Raw === "bigint" ? reserve0Raw : BigInt(reserve0Raw.toString()),
          reserve1: typeof reserve1Raw === "bigint" ? reserve1Raw : BigInt(reserve1Raw.toString()),
          decimals0: TOKEN_DECIMALS[pool.token0] ?? DEFAULT_TOKEN_DECIMALS,
          decimals1: TOKEN_DECIMALS[pool.token1] ?? DEFAULT_TOKEN_DECIMALS,
        });
      }

      // Pre-resolve the payment method so the sendOpts closure is synchronous
      const paymentMethod = await buildSponsoredFeePaymentMethod();
      const makeSendOpts = paymentMethod
        ? (from: import("@aztec/aztec.js/addresses").AztecAddress) => ({ from, fee: { paymentMethod } })
        : (from: import("@aztec/aztec.js/addresses").AztecAddress) => ({ from });

      await rebalancePools({
        priceFeed: priceFeed as unknown as Parameters<typeof rebalancePools>[0]["priceFeed"],
        minter: adminRef.current!,
        pools: poolStates,
        tokenPrices,
        sendOpts: makeSendOpts,
        onProgress: (step, total, label) => {
          setProgress({ step, total, label });
        },
        tokenLabels,
      });

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
      <PriceRowList
        rows={rows}
        connected={connected}
        executing={executing}
        isDemo={isDemo}
        onPriceChange={handlePriceChange}
        onRemove={removeToken}
      />

      {/* Add Asset */}
      {!executing && (
        <AddAssetSearch
          availableTokens={AVAILABLE_TOKENS}
          addedSymbols={addedSymbols}
          onAdd={addToken}
        />
      )}

      {/* Changes preview */}
      {!executing && <ChangesPreview changedTokens={changedTokens} />}

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
