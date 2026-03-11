"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";

export interface TokenSectionProps {
  label: string;
  token: Token;
  onTokenChange: (t: Token) => void;
  amount: string;
  onAmountChange: (v: string) => void;
  balance: string;
  balanceLoading?: boolean;
  onRefresh?: () => void;
  onMax?: () => void;
  tokenOptions: Token[];
  readOnly: boolean;
  dimmed?: boolean;
}

export default function TokenSection({
  label,
  token,
  onTokenChange,
  amount,
  onAmountChange,
  balance,
  balanceLoading,
  onRefresh,
  onMax,
  tokenOptions,
  readOnly,
  dimmed,
}: TokenSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl bg-neutral-50 border border-neutral-100 p-4 mb-1">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <span className="text-xs text-neutral-500 font-medium">{label}</span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-200 text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              <Icon icon="lucide:refresh-cw" className="w-3 h-3" />
            </button>
          )}
        </div>
        <span className="text-xs text-neutral-400 font-mono flex items-center gap-1.5">
          Balance:{" "}
          {balanceLoading ? (
            <span className="inline-block w-3 h-3 border border-neutral-300 border-t-transparent rounded-full animate-spin align-middle" />
          ) : (
            balance
          )}
          {onMax && (
            <button
              onClick={onMax}
              className="text-[10px] font-semibold text-orange-500 hover:text-orange-600 uppercase"
            >
              Max
            </button>
          )}
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
              {tokenOptions.map((t) => (
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
          readOnly={readOnly}
          className={`flex-1 text-right text-xl font-mono bg-transparent outline-none placeholder:text-neutral-300 ${
            dimmed ? "text-neutral-400" : "text-neutral-900"
          } ${readOnly ? "cursor-default" : ""}`}
        />
      </div>
    </div>
  );
}
