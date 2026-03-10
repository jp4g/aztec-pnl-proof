"use client";

import { Icon } from "@iconify/react";
import type { DecodedSwap, ProveFlowStatus, Token } from "@/types";
import StatusBadge from "@/components/ui/StatusBadge";
import TokenIcon from "@/components/ui/TokenIcon";
import { TOKEN_DECIMALS } from "@/hooks/useTokenBalances";

interface TransactionTableProps {
  swaps: DecodedSwap[];
  status: ProveFlowStatus;
  currentSwap: number;
  resolveToken: (address: string) => Token;
  formatAmount: (amount: bigint, decimals?: number) => string;
}

function getRowStatus(
  index: number,
  currentSwap: number,
  flowStatus: ProveFlowStatus,
): "proven" | "proving" | "pending" {
  if (flowStatus === "complete") return "proven";
  if (flowStatus === "proving" && index < currentSwap - 1) return "proven";
  if (flowStatus === "proving" && index === currentSwap - 1) return "proving";
  return "pending";
}

function getRowStyles(status: "proven" | "proving" | "pending") {
  switch (status) {
    case "proving":
      return "bg-blue-50/30";
    case "pending":
      return "opacity-60";
    default:
      return "group hover:bg-neutral-50 transition-colors";
  }
}

export default function TransactionTable({
  swaps,
  status,
  currentSwap,
  resolveToken,
  formatAmount,
}: TransactionTableProps) {
  if (swaps.length === 0 && status === "idle") {
    return (
      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
            Included Transactions
          </h2>
        </div>
        <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-12 text-center">
          <Icon
            icon="solar:inbox-linear"
            width={48}
            className="text-neutral-300 mx-auto mb-4"
          />
          <p className="text-neutral-500 text-sm">
            No swap events discovered yet. Click &quot;Generate ZK Proof&quot; to
            scan for encrypted swap transactions.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
          Included Transactions
        </h2>
        <span className="text-sm text-neutral-500">
          {swaps.length} swap{swaps.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-neutral-50/50 border-b border-neutral-100">
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Sell
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Amount
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-center" />
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Buy
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Amount
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Block
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-sm">
              {swaps.map((swap, i) => {
                const rowStatus = getRowStatus(i, currentSwap, status);
                const tokenIn = resolveToken(swap.tokenIn);
                const tokenOut = resolveToken(swap.tokenOut);
                return (
                  <tr key={i} className={getRowStyles(rowStatus)}>
                    <td className="py-4 px-6">
                      <StatusBadge status={rowStatus} />
                    </td>
                    <td className="py-4 px-6 font-medium text-neutral-900">
                      <div className="flex items-center gap-2">
                        <TokenIcon token={tokenIn} />
                        {tokenIn.symbol}
                      </div>
                    </td>
                    <td className="py-4 px-6 text-neutral-600 font-mono text-right">
                      {formatAmount(swap.amountIn, TOKEN_DECIMALS[tokenIn.symbol] ?? 9)}
                    </td>
                    <td className="py-4 px-6 text-center text-neutral-300">
                      <Icon icon="solar:arrow-right-linear" width={16} />
                    </td>
                    <td className="py-4 px-6 font-medium text-neutral-900">
                      <div className="flex items-center gap-2">
                        <TokenIcon token={tokenOut} />
                        {tokenOut.symbol}
                      </div>
                    </td>
                    <td className="py-4 px-6 text-neutral-600 font-mono text-right">
                      {formatAmount(swap.amountOut, TOKEN_DECIMALS[tokenOut.symbol] ?? 9)}
                    </td>
                    <td className="py-4 px-6 text-neutral-500 text-right font-mono">
                      #{swap.blockNumber.toString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
