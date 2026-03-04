"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Icon } from "@iconify/react";
import {
  TOKENS,
  MOCK_PRICES,
  getSwappableTokens,
  type TokenSymbol,
} from "@/data/dummy";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useTokenBalances, TOKEN_ADDRESSES, TOKEN_DECIMALS, formatTokenBalance } from "@/hooks/useTokenBalances";
import { useToast } from "@/hooks/useToast";

const tokenList = Object.values(TOKENS) as Token[];

const POOL_ADDRESSES: Record<string, string | undefined> = {
  "wETH/USDC": process.env.NEXT_PUBLIC_AMM_ETH_USDC,
  "wZEC/USDC": process.env.NEXT_PUBLIC_AMM_ZEC_USDC,
  "wAZTEC/USDC": process.env.NEXT_PUBLIC_AMM_AZTEC_USDC,
};

function getPoolAddress(a: string, b: string): string | null {
  const nonUsdc = a === "USDC" ? b : a;
  return POOL_ADDRESSES[`${nonUsdc}/USDC`] ?? null;
}

function toTokenAmount(amount: string, decimals: number): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded);
}

function parseBalance(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function isValidAmount(value: string): boolean {
  return /^\d*\.?\d*$/.test(value);
}

export default function SwapCard() {
  const { wallet, address, status: walletStatus, isDemoAccount } = useAztecWallet();
  const { getBalance, isLoading, fetchBalance, refreshAll, setBalance } = useTokenBalances();
  const { showToast } = useToast();

  const [sellToken, setSellToken] = useState<Token>(TOKENS.USDC);
  const [buyToken, setBuyToken] = useState<Token>(TOKENS.wETH);
  const [sellAmount, setSellAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [swapping, setSwapping] = useState(false);

  const connected = walletStatus === "connected";
  const isDemo = connected && address ? isDemoAccount(address) : false;

  const buyOptions = useMemo(
    () => getSwappableTokens(sellToken.symbol),
    [sellToken.symbol]
  );

  const estimatedOutput = useMemo(() => {
    const amt = parseFloat(sellAmount);
    if (!amt || amt <= 0) return "";
    const sellPrice = MOCK_PRICES[sellToken.symbol as TokenSymbol] ?? 0;
    const buyPrice = MOCK_PRICES[buyToken.symbol as TokenSymbol] ?? 0;
    if (!buyPrice) return "";
    const result = amt * (sellPrice / buyPrice);
    return result.toFixed(6).replace(/\.?0+$/, "");
  }, [sellAmount, sellToken.symbol, buyToken.symbol]);

  // Fetch balances when token selection changes
  useEffect(() => {
    if (connected) fetchBalance(sellToken.symbol);
  }, [connected, sellToken.symbol, fetchBalance]);
  useEffect(() => {
    if (connected) fetchBalance(buyToken.symbol);
  }, [connected, buyToken.symbol, fetchBalance]);

  const sellBalance = connected ? (getBalance(sellToken.symbol) ?? "\u2026") : "\u2014";
  const buyBalance = connected ? (getBalance(buyToken.symbol) ?? "\u2026") : "\u2014";

  const handleSellTokenChange = useCallback(
    (token: Token) => {
      setSellToken(token);
      const newBuyOptions = getSwappableTokens(token.symbol);
      if (!newBuyOptions.find((t) => t.symbol === buyToken.symbol)) {
        setBuyToken(newBuyOptions[0]);
      }
    },
    [buyToken.symbol]
  );

  const handleBuyTokenChange = useCallback((token: Token) => {
    setBuyToken(token);
  }, []);

  const handleAmountChange = useCallback((value: string) => {
    if (value === "" || isValidAmount(value)) {
      setSellAmount(value);
    }
  }, []);

  const flipTokens = useCallback(() => {
    const newSell = buyToken;
    const newBuy = sellToken;
    setSellToken(newSell);
    setBuyToken(newBuy);
    setSellAmount("");
  }, [sellToken, buyToken]);

  const handleSlippageChange = useCallback((value: string) => {
    const num = parseFloat(value);
    if (value === "") {
      setSlippage(0);
    } else if (!isNaN(num) && num >= 0 && num <= 10) {
      setSlippage(num);
    }
  }, []);

  const amt = parseFloat(sellAmount);
  const hasAmount = sellAmount.length > 0 && amt > 0;
  const insufficientBalance = hasAmount && amt > parseBalance(sellBalance);

  let buttonLabel = "Swap";
  let buttonDisabled = false;
  if (!connected) {
    buttonLabel = "Connect Wallet";
    buttonDisabled = true;
  } else if (isDemo) {
    buttonLabel = "Demo Account";
    buttonDisabled = true;
  } else if (!hasAmount) {
    buttonLabel = "Enter an amount";
    buttonDisabled = true;
  } else if (insufficientBalance) {
    buttonLabel = "Insufficient balance";
    buttonDisabled = true;
  } else if (swapping) {
    buttonLabel = "Swapping...";
    buttonDisabled = true;
  }

  const handleSwap = useCallback(async () => {
    if (!wallet || !address || swapping) return;

    const poolAddrHex = getPoolAddress(sellToken.symbol, buyToken.symbol);
    if (!poolAddrHex) {
      showToast("No pool found for this pair", "error");
      return;
    }

    const sellTokenAddr = TOKEN_ADDRESSES[sellToken.symbol];
    const buyTokenAddr = TOKEN_ADDRESSES[buyToken.symbol];
    if (!sellTokenAddr || !buyTokenAddr) {
      showToast("Token address not configured", "error");
      return;
    }

    setSwapping(true);
    try {
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { Fr } = await import("@aztec/aztec.js/fields");
      const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");
      const { AMMContractArtifact } = await import("@/artifacts/AMM");

      const poolAddr = AztecAddress.fromString(poolAddrHex);
      const sellAddr = AztecAddress.fromString(sellTokenAddr);
      const buyAddr = AztecAddress.fromString(buyTokenAddr);
      const owner = AztecAddress.fromString(address);

      const sellDecimals = TOKEN_DECIMALS[sellToken.symbol] ?? 18;
      const buyDecimals = TOKEN_DECIMALS[buyToken.symbol] ?? 18;
      const amountIn = toTokenAmount(sellAmount, sellDecimals);

      const tokenSell = await Contract.at(sellAddr, TokenContractArtifact, wallet);
      const tokenBuy = await Contract.at(buyAddr, TokenContractArtifact, wallet);
      const pool = await Contract.at(poolAddr, AMMContractArtifact, wallet);

      // Fetch pool reserves
      const [reserveIn, reserveOut] = await Promise.all([
        tokenSell.methods.balance_of_public(poolAddr).simulate({ from: owner }),
        tokenBuy.methods.balance_of_public(poolAddr).simulate({ from: owner }),
      ]);

      // Compute real output from AMM
      const amountOut = await pool.methods
        .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
        .simulate({ from: owner });

      // Apply slippage
      const amountOutBig = typeof amountOut === "bigint" ? amountOut : BigInt(amountOut.toString());
      const amountOutMin = amountOutBig * BigInt(Math.floor((100 - slippage) * 100)) / BigInt(10000);

      // Create authwit for the pool to transfer tokens on our behalf
      const nonce = Fr.random();
      const authwit = await wallet.createAuthWit(owner, {
        caller: poolAddr,
        action: tokenSell.methods.transfer_to_public(owner, poolAddr, amountIn, nonce),
      } as any);

      // Execute swap
      await pool.methods
        .swap_exact_tokens_for_tokens(sellAddr, buyAddr, amountIn, amountOutMin, nonce)
        .with({ authWitnesses: [authwit] })
        .send({ from: owner })
        .wait();

      // Optimistically update balances
      const prevSellRaw = parseBalance(sellBalance);
      const prevBuyRaw = parseBalance(buyBalance);
      const sellDelta = Number(amountIn) / 10 ** sellDecimals;
      const buyDelta = Number(amountOutBig) / 10 ** buyDecimals;
      setBalance(sellToken.symbol, formatTokenBalance(BigInt(Math.round((prevSellRaw - sellDelta) * 10 ** sellDecimals)), sellDecimals));
      setBalance(buyToken.symbol, formatTokenBalance(BigInt(Math.round((prevBuyRaw + buyDelta) * 10 ** buyDecimals)), buyDecimals));

      setSellAmount("");
      showToast(`Swapped ${sellAmount} ${sellToken.symbol} for ~${formatTokenBalance(amountOutBig, buyDecimals)} ${buyToken.symbol}`, "success");
    } catch (err) {
      console.error("Swap failed:", err);
      const msg = err instanceof Error ? err.message : "Swap failed";
      showToast(msg, "error");
    } finally {
      setSwapping(false);
    }
  }, [wallet, address, swapping, sellToken, buyToken, sellAmount, slippage, sellBalance, buyBalance, showToast, setBalance]);

  return (
    <div className="w-full max-w-md bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
      <h2 className="text-lg font-semibold text-neutral-900 mb-5">Swap</h2>

      {isDemo && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-700">
          Changing demo account state is restricted — make a new account to create a PnL proof with live data!
        </div>
      )}

      {/* You Pay */}
      <TokenSection
        label="You Pay"
        token={sellToken}
        onTokenChange={handleSellTokenChange}
        amount={sellAmount}
        onAmountChange={handleAmountChange}
        balance={sellBalance}
        balanceLoading={isLoading(sellToken.symbol)}
        onRefresh={connected ? refreshAll : undefined}
        tokenOptions={tokenList}
        readOnly={false}
      />

      {/* Flip button */}
      <div className="flex justify-center -my-2 relative z-10">
        <button
          onClick={flipTokens}
          className="w-9 h-9 rounded-full border border-neutral-200 bg-white flex items-center justify-center hover:bg-neutral-50 transition-colors"
        >
          <Icon
            icon="lucide:arrow-down-up"
            className="w-4 h-4 text-neutral-500"
          />
        </button>
      </div>

      {/* You Receive */}
      <TokenSection
        label="You Receive"
        token={buyToken}
        onTokenChange={handleBuyTokenChange}
        amount={estimatedOutput}
        onAmountChange={() => {}}
        balance={buyBalance}
        balanceLoading={isLoading(buyToken.symbol)}
        tokenOptions={buyOptions}
        readOnly={true}
      />

      {/* Slippage */}
      <div className="flex items-center justify-between mt-3 px-1">
        <span className="text-xs text-neutral-500">Slippage tolerance</span>
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => handleSlippageChange(e.target.value)}
            className="w-12 text-right text-xs font-mono bg-neutral-50 border border-neutral-200 rounded px-1.5 py-0.5 outline-none focus:border-orange-400"
          />
          <span className="text-xs text-neutral-400">%</span>
        </div>
      </div>

      {/* Swap button */}
      <button
        onClick={handleSwap}
        disabled={buttonDisabled}
        className="mt-4 w-full py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:bg-neutral-100 disabled:text-neutral-400 disabled:cursor-not-allowed bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700"
      >
        {swapping && (
          <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        )}
        {buttonLabel}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TokenSection({
  label,
  token,
  onTokenChange,
  amount,
  onAmountChange,
  balance,
  balanceLoading,
  onRefresh,
  tokenOptions,
  readOnly,
}: {
  label: string;
  token: Token;
  onTokenChange: (t: Token) => void;
  amount: string;
  onAmountChange: (v: string) => void;
  balance: string;
  balanceLoading?: boolean;
  onRefresh?: () => void;
  tokenOptions: Token[];
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl bg-neutral-50 border border-neutral-100 p-4 mb-1">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <span className="text-xs text-neutral-500 font-medium">{label}</span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-200 text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              <Icon icon="lucide:refresh-cw" className="w-3 h-3" />
            </button>
          )}
        </div>
        <span className="text-xs text-neutral-400 font-mono">
          Balance:{" "}
          {balanceLoading ? (
            <span className="inline-block w-3 h-3 border border-neutral-300 border-t-transparent rounded-full animate-spin align-middle" />
          ) : (
            balance
          )}
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/* Token selector */}
        <div className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-neutral-200 hover:border-neutral-300 transition-colors"
          >
            <TokenIcon token={token} size="sm" />
            <span className="text-sm font-medium text-neutral-800">
              {token.symbol}
            </span>
            <Icon
              icon="lucide:chevron-down"
              className="w-3.5 h-3.5 text-neutral-400"
            />
          </button>

          {open && (
            <div className="absolute top-full left-0 mt-1 w-36 bg-white border border-neutral-200 rounded-lg shadow-lg py-1 z-20">
              {tokenOptions.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => {
                    onTokenChange(t);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-neutral-50 transition-colors ${
                    t.symbol === token.symbol
                      ? "text-orange-600 font-medium"
                      : "text-neutral-700"
                  }`}
                >
                  <TokenIcon token={t} size="sm" />
                  {t.symbol}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Amount input */}
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          readOnly={readOnly}
          className={`flex-1 text-right text-xl font-mono bg-transparent outline-none placeholder:text-neutral-300 text-neutral-900 ${
            readOnly ? "cursor-default" : ""
          }`}
        />
      </div>
    </div>
  );
}
