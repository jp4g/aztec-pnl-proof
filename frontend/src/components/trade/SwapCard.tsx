"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { TOKENS, DUMMY_BALANCES } from "@/data/dummy";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useToast } from "@/hooks/useToast";

type TokenSymbol = keyof typeof TOKENS;
const tokenList = Object.values(TOKENS) as Token[];

type SwapState = "idle" | "executing" | "done";

export default function SwapCard() {
  const { status: walletStatus } = useAztecWallet();
  const { showToast } = useToast();

  const [tokenOut, setTokenOut] = useState<Token>(TOKENS.ETH);
  const [tokenIn, setTokenIn] = useState<Token>(TOKENS.USDC);
  const [amountOut, setAmountOut] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [swapState, setSwapState] = useState<SwapState>("idle");

  const connected = walletStatus === "connected";

  const flipTokens = () => {
    setTokenOut(tokenIn);
    setTokenIn(tokenOut);
    setAmountOut(amountIn);
    setAmountIn(amountOut);
  };

  const executeSwap = async () => {
    setSwapState("executing");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const success = Math.random() > 0.3;
    setSwapState("done");
    if (success) {
      showToast(
        `Swapped ${amountOut} ${tokenOut.symbol} for ${amountIn || "?"} ${tokenIn.symbol}`,
        "success"
      );
    } else {
      showToast("Swap failed. Please try again.", "error");
    }
    // Reset after a brief moment
    setTimeout(() => setSwapState("idle"), 500);
  };

  const canExecute =
    connected &&
    swapState === "idle" &&
    amountOut.length > 0 &&
    parseFloat(amountOut) > 0;

  return (
    <div className="w-full max-w-md bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
      <h2 className="text-lg font-semibold text-neutral-900 mb-5">Swap</h2>

      {/* You Pay */}
      <TokenSection
        label="You Pay"
        token={tokenOut}
        onTokenChange={setTokenOut}
        amount={amountOut}
        onAmountChange={setAmountOut}
        otherToken={tokenIn}
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
        token={tokenIn}
        onTokenChange={setTokenIn}
        amount={amountIn}
        onAmountChange={setAmountIn}
        otherToken={tokenOut}
      />

      {/* Swap button */}
      <button
        onClick={executeSwap}
        disabled={!canExecute}
        className="mt-5 w-full py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:bg-neutral-100 disabled:text-neutral-400 disabled:cursor-not-allowed bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700"
      >
        {swapState === "executing" ? (
          <>
            <Icon
              icon="lucide:loader-2"
              className="w-4 h-4 animate-spin"
            />
            Swapping...
          </>
        ) : !connected ? (
          "Connect Wallet"
        ) : (
          "Swap"
        )}
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
  otherToken,
}: {
  label: string;
  token: Token;
  onTokenChange: (t: Token) => void;
  amount: string;
  onAmountChange: (v: string) => void;
  otherToken: Token;
}) {
  const [open, setOpen] = useState(false);

  const balance =
    DUMMY_BALANCES[token.symbol as TokenSymbol] ?? "0.00";

  return (
    <div className="rounded-xl bg-neutral-50 border border-neutral-100 p-4 mb-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-neutral-500 font-medium">{label}</span>
        <span className="text-xs text-neutral-400 font-mono">
          Balance: {balance}
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
              {tokenList
                .filter((t) => t.symbol !== otherToken.symbol)
                .map((t) => (
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
          className="flex-1 text-right text-xl font-mono bg-transparent outline-none placeholder:text-neutral-300 text-neutral-900"
        />
      </div>
    </div>
  );
}
