"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Icon } from "@iconify/react";
import {
  TOKENS,
  getSwappableTokens,
} from "@/data/dummy";
import { Token } from "@/types";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useTokenBalances, formatTokenBalance } from "@/hooks/useTokenBalances";
import { useQuoteSwap } from "@/hooks/useQuoteSwap";
import { TOKEN_ADDRESSES, TOKEN_DECIMALS, POOL_ADDRESSES } from "@/config/contracts";
import { useToast } from "@/hooks/useToast";
import { toTokenAmount, parseBalance, isValidAmount } from "@/lib/token-utils";
import TokenSection from "./TokenSection";

const tokenList = Object.values(TOKENS) as Token[];

function getPoolAddress(a: string, b: string): string | null {
  const nonUsdc = a === "USDC" ? b : a;
  return POOL_ADDRESSES[`${nonUsdc}/USDC`] ?? null;
}


export default function SwapCard() {
  const { wallet, address, status: walletStatus, isDemoAccount } = useAztecWallet();
  const { getBalance, getRawBalance, isLoading, fetchBalance, refreshAll, setBalance, refreshCounter } = useTokenBalances();
  const { showToast } = useToast();

  const [sellToken, setSellToken] = useState<Token>(TOKENS.USDC);
  const [buyToken, setBuyToken] = useState<Token>(TOKENS.wETH);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [activeInput, setActiveInput] = useState<"sell" | "buy">("sell");
  const [slippage, setSlippage] = useState(1);
  const [swapping, setSwapping] = useState(false);

  const connected = walletStatus === "connected";
  const isDemo = connected && address ? isDemoAccount(address) : false;

  const buyOptions = useMemo(
    () => getSwappableTokens(sellToken.symbol),
    [sellToken.symbol]
  );

  // Quote the other side when user types in either input
  const { quoting, quotedSellAmount, quotedBuyAmount } = useQuoteSwap({
    wallet,
    address,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    activeInput,
  });

  // Sync quoted buy amount into local state (sell-side quoting)
  useEffect(() => {
    if (activeInput === "sell" && quotedBuyAmount !== undefined) {
      setBuyAmount(quotedBuyAmount);
    }
  }, [activeInput, quotedBuyAmount]);

  // Sync quoted sell amount into local state (buy-side quoting)
  useEffect(() => {
    if (activeInput === "buy" && quotedSellAmount !== undefined) {
      setSellAmount(quotedSellAmount);
    }
  }, [activeInput, quotedSellAmount]);

  // Fetch balances when token selection changes or refresh is triggered
  useEffect(() => {
    if (connected) fetchBalance(sellToken.symbol);
  }, [connected, sellToken.symbol, fetchBalance, refreshCounter]);
  useEffect(() => {
    if (connected) fetchBalance(buyToken.symbol);
  }, [connected, buyToken.symbol, fetchBalance, refreshCounter]);

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
      setActiveInput("sell");
      setSellAmount(value);
    }
  }, []);

  const handleBuyAmountChange = useCallback((value: string) => {
    if (value === "" || isValidAmount(value)) {
      setActiveInput("buy");
      setBuyAmount(value);
    }
  }, []);

  const handleMax = useCallback(() => {
    const raw = getRawBalance(sellToken.symbol);
    if (!raw || raw <= 0n) return;
    const decimals = TOKEN_DECIMALS[sellToken.symbol] ?? 9;
    // Use full precision so the exact raw amount is sent
    const whole = raw / 10n ** BigInt(decimals);
    const frac = raw % 10n ** BigInt(decimals);
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const fullPrecision = fracStr ? `${whole}.${fracStr}` : `${whole}`;
    setActiveInput("sell");
    setSellAmount(fullPrecision);
  }, [getRawBalance, sellToken.symbol]);

  const flipTokens = useCallback(() => {
    const newSell = buyToken;
    const newBuy = sellToken;
    setSellToken(newSell);
    setBuyToken(newBuy);
    setSellAmount("");
    setBuyAmount("");
    setActiveInput("sell");
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
      const { AMMContractArtifact } = await import("@privpnl/contracts/AMM");

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
      } as any); // AuthWit generic param mismatch between Contract.at and EmbeddedWallet

      // Execute swap
      await pool.methods
        .swap_exact_tokens_for_tokens(sellAddr, buyAddr, amountIn, amountOutMin, nonce)
        .with({ authWitnesses: [authwit] })
        .send({ from: owner });

      // Optimistically update balances
      const prevSellRaw = parseBalance(sellBalance);
      const prevBuyRaw = parseBalance(buyBalance);
      const sellDelta = Number(amountIn) / 10 ** sellDecimals;
      const buyDelta = Number(amountOutBig) / 10 ** buyDecimals;
      setBalance(sellToken.symbol, formatTokenBalance(BigInt(Math.round((prevSellRaw - sellDelta) * 10 ** sellDecimals)), sellDecimals));
      setBalance(buyToken.symbol, formatTokenBalance(BigInt(Math.round((prevBuyRaw + buyDelta) * 10 ** buyDecimals)), buyDecimals));

      setSellAmount("");
      setBuyAmount("");
      setActiveInput("sell");
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
        onMax={connected && !isDemo ? handleMax : undefined}
        tokenOptions={tokenList}
        readOnly={false}
        dimmed={activeInput === "buy" && quoting}
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
        amount={buyAmount}
        onAmountChange={handleBuyAmountChange}
        balance={buyBalance}
        balanceLoading={isLoading(buyToken.symbol)}
        tokenOptions={buyOptions}
        readOnly={false}
        dimmed={activeInput === "sell" && quoting}
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
