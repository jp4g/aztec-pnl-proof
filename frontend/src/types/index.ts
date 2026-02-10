export type ProofStatus = "proven" | "proving" | "pending" | "unused";

export type TreeNodeStatus = "verified" | "proving" | "pending" | "unused";

export interface Token {
  symbol: string;
  color: string; // tailwind bg class for the icon circle
}

export interface Transaction {
  id: string;
  status: ProofStatus;
  tokenOut: Token;
  amountOut: string;
  tokenIn: Token;
  amountIn: string;
  date: string;
}

export interface TreeNode {
  id: string;
  status: TreeNodeStatus;
  label?: string;
}

export interface ProofState {
  status: "idle" | "generating" | "complete" | "error";
  progress: number; // 0-100
  currentLeaf: number | null;
  blockNumber: string;
  estimatedTime: string;
  totalTransactions: number;
  pnlAmount: string;
  pnlPercent: string;
  pnlPositive: boolean;
}
