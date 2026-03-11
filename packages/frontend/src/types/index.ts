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

/** Status of the prove flow state machine */
export type ProveFlowStatus =
  | "idle"
  | "discovering"
  | "proving"
  | "aggregating"
  | "taxing"
  | "complete"
  | "error";

/** A decoded swap from the proof pipeline */
export interface DecodedSwap {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber: bigint;
}

/** A proof artifact ready for download/verification */
export interface DownloadableProof {
  type: "pnl" | "tax";
  proof: string; // hex-encoded proof bytes
  publicInputs: Record<string, string>;
}

/** Full state of the prove flow */
export interface ProveFlowState {
  status: ProveFlowStatus;
  // Event discovery
  totalEvents: number;
  // Proof progress
  currentSwap: number;
  totalSwaps: number;
  statusText: string;
  progress: number; // 0-100
  // Results
  pnl: bigint | null;
  tax: bigint | null;
  merkleRoot: string | null;
  blockNumber: bigint | null;
  pnlProof: DownloadableProof | null;
  taxProof: DownloadableProof | null;
  // Decoded swap data for transaction table
  swaps: DecodedSwap[];
  // Tree visualization — bottom-up: [leaves, ...intermediates, root]
  treeLevels: TreeNode[][];
  // Error
  error: string | null;
}
