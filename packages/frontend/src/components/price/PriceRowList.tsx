import { Icon } from "@iconify/react";
import { TOKENS } from "@/config/tokens";
import { TOKEN_ADDRESSES } from "@/config/contracts";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";

const AVAILABLE_TOKENS = Object.entries(TOKENS)
  .filter(([sym]) => TOKEN_ADDRESSES[sym])
  .map(([symbol, token]) => ({ symbol, token: token as Token }));

export interface TokenPriceRow {
  symbol: string;
  currentPrice: string;
  newPrice: string;
  loading: boolean;
}

export function formatUsd(value: number): string {
  if (value >= 1) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function isValidPrice(value: string): boolean {
  if (value === "") return true;
  return /^\d*\.?\d*$/.test(value) && !(value.startsWith("0") && value.length > 1 && value[1] !== ".");
}

/** Re-export so parent can derive the set without re-computing */
export { AVAILABLE_TOKENS };

interface PriceRowListProps {
  rows: TokenPriceRow[];
  connected: boolean;
  executing: boolean;
  isDemo: boolean;
  onPriceChange: (symbol: string, value: string) => void;
  onRemove: (symbol: string) => void;
}

export default function PriceRowList({
  rows,
  connected,
  executing,
  isDemo,
  onPriceChange,
  onRemove,
}: PriceRowListProps) {
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <div className="text-center py-6 text-sm text-neutral-400">
          Add tokens to set their oracle prices
        </div>
      )}
      {rows.map((row) => {
        const tokenDef = AVAILABLE_TOKENS.find((t) => t.symbol === row.symbol);
        const isChanged = row.currentPrice !== "" && row.newPrice !== "" && row.newPrice !== row.currentPrice;

        return (
          <div
            key={row.symbol}
            className="flex items-center gap-3 rounded-xl bg-neutral-50 border border-neutral-100 px-4 py-3"
          >
            {tokenDef && <TokenIcon token={tokenDef.token} size="sm" />}
            <span className="text-sm font-medium text-neutral-800 w-16">{row.symbol}</span>
            <span className="text-xs text-neutral-400 flex-shrink-0">
              {row.loading ? (
                <span className="inline-block w-3 h-3 border border-neutral-300 border-t-transparent rounded-full animate-spin align-middle" />
              ) : row.currentPrice ? (
                `$${formatUsd(parseFloat(row.currentPrice))}`
              ) : (
                "--"
              )}
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={row.newPrice}
              onChange={(e) => onPriceChange(row.symbol, e.target.value)}
              disabled={!connected || executing || isDemo}
              className="flex-1 text-right text-sm font-mono bg-white border border-neutral-200 rounded-lg px-2 py-1.5 outline-none focus:border-orange-400 disabled:bg-neutral-100 disabled:text-neutral-400"
            />
            {isChanged && (
              <span className="text-orange-500 text-sm font-bold flex-shrink-0">*</span>
            )}
            {!executing && (
              <button
                onClick={() => onRemove(row.symbol)}
                className="w-5 h-5 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 hover:bg-neutral-200 transition-colors flex-shrink-0"
              >
                <Icon icon="lucide:x" width={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
