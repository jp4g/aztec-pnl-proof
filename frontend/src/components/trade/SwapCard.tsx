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
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useToast } from "@/hooks/useToast";

const tokenList = Object.values(TOKENS) as Token[];

function parseBalance(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function isValidAmount(value: string): boolean {
  return /^\d*\.?\d*$/.test(value);
}

export default function SwapCard() {
  const { status: walletStatus } = useAztecWallet();
  const { getBalance, isLoading, fetchBalance, refreshAll } = useTokenBalances();
  const { showToast } = useToast();

  const [sellToken, setSellToken] = useState<Token>(TOKENS.USDC);
  const [buyToken, setBuyToken] = useState<Token>(TOKENS.wETH);
  const [sellAmount, setSellAmount] = useState("");

  const connected = walletStatus === "connected";

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

  const amt = parseFloat(sellAmount);
  const hasAmount = sellAmount.length > 0 && amt > 0;
  const insufficientBalance = hasAmount && amt > parseBalance(sellBalance);

  let buttonLabel = "Swap";
  let buttonDisabled = false;
  if (!connected) {
    buttonLabel = "Connect Wallet";
    buttonDisabled = true;
  } else if (!hasAmount) {
    buttonLabel = "Enter an amount";
    buttonDisabled = true;
  } else if (insufficientBalance) {
    buttonLabel = "Insufficient balance";
    buttonDisabled = true;
  }

  const handleSwap = () => {
    showToast("Swap execution coming soon", "success");
  };

  return (
    <div className="w-full max-w-md bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
      <h2 className="text-lg font-semibold text-neutral-900 mb-5">Swap</h2>

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

      {/* Swap button */}
      <button
        onClick={handleSwap}
        disabled={buttonDisabled}
        className="mt-5 w-full py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:bg-neutral-100 disabled:text-neutral-400 disabled:cursor-not-allowed bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700"
      >
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
