import { Token } from "@/types";

export const TOKENS = {
  USDC: { symbol: "USDC", color: "bg-indigo-100" },
  wETH: { symbol: "wETH", color: "bg-blue-100" },
  wZEC: { symbol: "wZEC", color: "bg-amber-100" },
  wAZTEC: { symbol: "wAZTEC", color: "bg-purple-100" },
} as const;

export type TokenSymbol = keyof typeof TOKENS;

export const POOLS: [TokenSymbol, TokenSymbol][] = [
  ["wETH", "USDC"],
  ["wZEC", "USDC"],
  ["wAZTEC", "USDC"],
];

export function getSwappableTokens(sellSymbol: string): Token[] {
  const reachable = new Set<string>();
  for (const [a, b] of POOLS) {
    if (a === sellSymbol) reachable.add(b);
    if (b === sellSymbol) reachable.add(a);
  }
  return Object.values(TOKENS).filter((t) => reachable.has(t.symbol));
}
