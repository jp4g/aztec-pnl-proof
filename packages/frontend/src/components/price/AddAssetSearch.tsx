import { useState, useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { Token } from "@/types";
import TokenIcon from "@/components/ui/TokenIcon";

interface AvailableToken {
  symbol: string;
  token: Token;
}

interface AddAssetSearchProps {
  availableTokens: AvailableToken[];
  addedSymbols: Set<string>;
  onAdd: (symbol: string) => void;
}

export default function AddAssetSearch({
  availableTokens,
  addedSymbols,
  onAdd,
}: AddAssetSearchProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

  // Close search dropdown when clicking outside
  useEffect(() => {
    if (!showSearch) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSearch]);

  const filteredAvailable = availableTokens.filter(
    (t) => !addedSymbols.has(t.symbol) && t.symbol.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (addedSymbols.size >= availableTokens.length) return null;

  return (
    <div className="relative mt-2" ref={searchRef}>
      <button
        onClick={() => setShowSearch((v) => !v)}
        className="w-full py-2 rounded-xl border border-dashed border-neutral-300 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors flex items-center justify-center gap-1.5"
      >
        <Icon icon="lucide:plus" width={14} />
        Add Asset
      </button>
      {showSearch && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-neutral-200 rounded-xl shadow-lg z-10 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-100">
            <Icon icon="lucide:search" width={14} className="text-neutral-400" />
            <input
              type="text"
              placeholder="Search tokens..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
              className="flex-1 text-sm outline-none bg-transparent placeholder:text-neutral-400"
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {filteredAvailable.length === 0 ? (
              <div className="px-3 py-2 text-xs text-neutral-400">No matches</div>
            ) : (
              filteredAvailable.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => {
                    onAdd(t.symbol);
                    setShowSearch(false);
                    setSearchQuery("");
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-neutral-50 transition-colors"
                >
                  <TokenIcon token={t.token} size="sm" />
                  <span className="text-sm font-medium text-neutral-800">{t.symbol}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
