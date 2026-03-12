"use client";

import { useEffect, useState } from "react";
import { Token } from "@/types";
import { TOKEN_ADDRESSES, TOKEN_DECIMALS, DEFAULT_TOKEN_DECIMALS } from "@/config/contracts";
import { toTokenAmount, formatTokenBalance, getPoolAddress } from "@/lib/token-utils";

interface UseQuoteSwapArgs {
  wallet: any;
  address: string | null;
  sellToken: Token;
  buyToken: Token;
  sellAmount: string;
  buyAmount: string;
  activeInput: "sell" | "buy";
}

interface UseQuoteSwapResult {
  quoting: boolean;
  quotedSellAmount: string;
  quotedBuyAmount: string;
}

export function useQuoteSwap({
  wallet,
  address,
  sellToken,
  buyToken,
  sellAmount,
  buyAmount,
  activeInput,
}: UseQuoteSwapArgs): UseQuoteSwapResult {
  const [quoting, setQuoting] = useState(false);
  const [quotedSellAmount, setQuotedSellAmount] = useState("");
  const [quotedBuyAmount, setQuotedBuyAmount] = useState("");

  useEffect(() => {
    if (!wallet || !address) return;

    const poolAddrHex = getPoolAddress(sellToken.symbol, buyToken.symbol);
    if (!poolAddrHex) return;

    // Determine which side is being quoted
    const inputAmount = activeInput === "sell" ? sellAmount : buyAmount;
    const amt = parseFloat(inputAmount);
    if (!amt || amt <= 0) {
      if (activeInput === "sell") {
        setQuotedBuyAmount("");
      } else {
        setQuotedSellAmount("");
      }
      return;
    }

    let cancelled = false;
    setQuoting(true);

    (async () => {
      try {
        const { AztecAddress } = await import("@aztec/aztec.js/addresses");
        const { Contract } = await import("@aztec/aztec.js/contracts");
        const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");
        const { AMMContractArtifact } = await import("@privpnl/contracts/AMM");

        const poolAddr = AztecAddress.fromString(poolAddrHex);
        const sellAddr = AztecAddress.fromString(TOKEN_ADDRESSES[sellToken.symbol]!);
        const buyAddr = AztecAddress.fromString(TOKEN_ADDRESSES[buyToken.symbol]!);
        const owner = AztecAddress.fromString(address!);

        const tokenSell = await Contract.at(sellAddr, TokenContractArtifact, wallet);
        const tokenBuy = await Contract.at(buyAddr, TokenContractArtifact, wallet);
        const pool = await Contract.at(poolAddr, AMMContractArtifact, wallet);

        const [reserveIn, reserveOut] = await Promise.all([
          tokenSell.methods.balance_of_public(poolAddr).simulate({ from: owner }),
          tokenBuy.methods.balance_of_public(poolAddr).simulate({ from: owner }),
        ]);

        const sellDecimals = TOKEN_DECIMALS[sellToken.symbol] ?? DEFAULT_TOKEN_DECIMALS;
        const buyDecimals = TOKEN_DECIMALS[buyToken.symbol] ?? DEFAULT_TOKEN_DECIMALS;

        if (activeInput === "sell") {
          const amountIn = toTokenAmount(sellAmount, sellDecimals);
          const amountOut = await pool.methods
            .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
            .simulate({ from: owner });

          if (!cancelled) {
            const outBig = typeof amountOut === "bigint" ? amountOut : BigInt(amountOut.toString());
            const formatted = formatTokenBalance(outBig, buyDecimals);
            setQuotedBuyAmount(formatted.replace(/,/g, ""));
          }
        } else {
          const amountOut = toTokenAmount(buyAmount, buyDecimals);
          const amountIn = await pool.methods
            .get_amount_in_for_exact_out(reserveIn, reserveOut, amountOut)
            .simulate({ from: owner });

          if (!cancelled) {
            const inBig = typeof amountIn === "bigint" ? amountIn : BigInt(amountIn.toString());
            const formatted = formatTokenBalance(inBig, sellDecimals);
            setQuotedSellAmount(formatted.replace(/,/g, ""));
          }
        }
      } catch (err) {
        console.warn("Quote failed:", err);
        if (!cancelled) {
          if (activeInput === "sell") {
            setQuotedBuyAmount("");
          } else {
            setQuotedSellAmount("");
          }
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    })();

    return () => { cancelled = true; };
  }, [wallet, address, sellAmount, buyAmount, activeInput, sellToken.symbol, buyToken.symbol]);

  return { quoting, quotedSellAmount, quotedBuyAmount };
}
