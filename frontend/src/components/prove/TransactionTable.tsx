"use client";

import { Icon } from "@iconify/react";
import { Transaction } from "@/types";
import StatusBadge from "@/components/ui/StatusBadge";
import TokenIcon from "@/components/ui/TokenIcon";

interface TransactionTableProps {
  transactions: Transaction[];
}

function getRowStyles(status: Transaction["status"]) {
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
  transactions,
}: TransactionTableProps) {
  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
          Included Transactions
        </h2>
        <button className="text-sm text-orange-600 font-medium hover:text-orange-700 flex items-center gap-1">
          Export CSV
          <Icon icon="solar:export-linear" width={16} />
        </button>
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
                  Token Out
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Amount Out
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-center" />
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Token In
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Amount In
                </th>
                <th className="py-4 px-6 text-xs font-medium text-neutral-500 uppercase tracking-wider text-right">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-sm">
              {transactions.map((tx) => (
                <tr key={tx.id} className={getRowStyles(tx.status)}>
                  <td className="py-4 px-6">
                    <StatusBadge status={tx.status} />
                  </td>
                  <td className="py-4 px-6 font-medium text-neutral-900">
                    <div className="flex items-center gap-2">
                      <TokenIcon token={tx.tokenOut} />
                      {tx.tokenOut.symbol}
                    </div>
                  </td>
                  <td className="py-4 px-6 text-neutral-600 font-mono text-right">
                    {tx.amountOut}
                  </td>
                  <td className="py-4 px-6 text-center text-neutral-300">
                    <Icon icon="solar:arrow-right-linear" width={16} />
                  </td>
                  <td className="py-4 px-6 font-medium text-neutral-900">
                    <div className="flex items-center gap-2">
                      <TokenIcon token={tx.tokenIn} />
                      {tx.tokenIn.symbol}
                    </div>
                  </td>
                  <td className="py-4 px-6 text-neutral-600 font-mono text-right">
                    {tx.amountIn}
                  </td>
                  <td className="py-4 px-6 text-neutral-500 text-right">
                    {tx.date}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
