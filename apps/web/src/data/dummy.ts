import { Transaction, TreeNode, ProofState, Token } from "@/types";

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

export const MOCK_PRICES: Record<TokenSymbol, number> = {
  USDC: 1,
  wETH: 2800,
  wZEC: 30,
  wAZTEC: 0.1,
};

export function getSwappableTokens(sellSymbol: string): Token[] {
  const reachable = new Set<string>();
  for (const [a, b] of POOLS) {
    if (a === sellSymbol) reachable.add(b);
    if (b === sellSymbol) reachable.add(a);
  }
  return Object.values(TOKENS).filter((t) => reachable.has(t.symbol));
}

export const dummyTransactions: Transaction[] = [
  {
    id: "tx-1",
    status: "proven",
    tokenOut: TOKENS.wETH,
    amountOut: "1.50",
    tokenIn: TOKENS.USDC,
    amountIn: "4,200.00",
    date: "Oct 24, 14:30",
  },
  {
    id: "tx-2",
    status: "proven",
    tokenOut: TOKENS.USDC,
    amountOut: "5,000.00",
    tokenIn: TOKENS.wZEC,
    amountIn: "166.67",
    date: "Oct 24, 12:15",
  },
  {
    id: "tx-3",
    status: "proven",
    tokenOut: TOKENS.wAZTEC,
    amountOut: "500.00",
    tokenIn: TOKENS.USDC,
    amountIn: "50.00",
    date: "Oct 23, 09:42",
  },
  {
    id: "tx-4",
    status: "proving",
    tokenOut: TOKENS.USDC,
    amountOut: "1,000.00",
    tokenIn: TOKENS.wETH,
    amountIn: "0.3571",
    date: "Oct 22, 18:20",
  },
  {
    id: "tx-5",
    status: "pending",
    tokenOut: TOKENS.wZEC,
    amountOut: "10.00",
    tokenIn: TOKENS.USDC,
    amountIn: "300.00",
    date: "Oct 21, 11:05",
  },
];

export const dummyTreeLeaves: TreeNode[] = [
  { id: "leaf-1", status: "verified", label: "Tx 1" },
  { id: "leaf-2", status: "verified", label: "Tx 2" },
  { id: "leaf-3", status: "verified", label: "Tx 3" },
  { id: "leaf-4", status: "proving", label: "Tx 4" },
  { id: "leaf-5", status: "pending", label: "Tx 5" },
  { id: "leaf-6", status: "unused", label: "Pad" },
  { id: "leaf-7", status: "unused", label: "Pad" },
  { id: "leaf-8", status: "unused", label: "Pad" },
];

export const dummyTreeIntermediatesL2: TreeNode[] = [
  { id: "int-2-1", status: "verified" },
  { id: "int-2-2", status: "pending" },
  { id: "int-2-3", status: "pending" },
  { id: "int-2-4", status: "unused" },
];

export const dummyTreeIntermediatesL1: TreeNode[] = [
  { id: "int-1-1", status: "pending" },
  { id: "int-1-2", status: "unused" },
];

export const dummyTreeRoot: TreeNode = {
  id: "root",
  status: "pending",
  label: "Root",
};

export const dummyProofState: ProofState = {
  status: "generating",
  progress: 45,
  currentLeaf: 4,
  blockNumber: "892102",
  estimatedTime: "~45s",
  totalTransactions: 42,
  pnlAmount: "$12,450.32",
  pnlPercent: "+15.4%",
  pnlPositive: true,
};
