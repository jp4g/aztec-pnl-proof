/**
 * Single source of truth for all contract addresses and token metadata.
 * Next.js requires literal `process.env.NEXT_PUBLIC_*` for static replacement.
 */

export const TOKEN_ADDRESSES: Record<string, string | undefined> = {
  USDC: process.env.NEXT_PUBLIC_TOKEN_USDC,
  wETH: process.env.NEXT_PUBLIC_TOKEN_WETH,
  wZEC: process.env.NEXT_PUBLIC_TOKEN_WZEC,
  wAZTEC: process.env.NEXT_PUBLIC_TOKEN_WAZTEC,
};

export const DEFAULT_TOKEN_DECIMALS = 9;

export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  wETH: 9,
  wZEC: 9,
  wAZTEC: 9,
};

export const POOL_ADDRESSES: Record<string, string | undefined> = {
  "wETH/USDC": process.env.NEXT_PUBLIC_AMM_ETH_USDC,
  "wZEC/USDC": process.env.NEXT_PUBLIC_AMM_ZEC_USDC,
  "wAZTEC/USDC": process.env.NEXT_PUBLIC_AMM_AZTEC_USDC,
};

export const LP_ADDRESSES: Record<string, string | undefined> = {
  "ETH/USDC": process.env.NEXT_PUBLIC_LP_ETH_USDC,
  "ZEC/USDC": process.env.NEXT_PUBLIC_LP_ZEC_USDC,
  "AZTEC/USDC": process.env.NEXT_PUBLIC_LP_AZTEC_USDC,
};

export const PRICE_FEED_ADDRESS = process.env.NEXT_PUBLIC_PRICE_FEED;

export const POOL_DEFS = [
  { label: "wETH/USDC", token0: "wETH", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_ETH_USDC },
  { label: "wZEC/USDC", token0: "wZEC", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_ZEC_USDC },
  { label: "wAZTEC/USDC", token0: "wAZTEC", token1: "USDC", address: process.env.NEXT_PUBLIC_AMM_AZTEC_USDC },
];
