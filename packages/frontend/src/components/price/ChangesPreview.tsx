import { formatUsd, type TokenPriceRow } from "./PriceRowList";

interface ChangesPreviewProps {
  changedTokens: TokenPriceRow[];
}

export default function ChangesPreview({ changedTokens }: ChangesPreviewProps) {
  if (changedTokens.length === 0) return null;

  return (
    <div className="mt-4 px-1">
      <span className="text-xs text-neutral-500 font-medium">Changes:</span>
      <div className="mt-1 space-y-0.5">
        {changedTokens.map((t) => (
          <div key={t.symbol} className="text-xs text-neutral-600">
            {t.symbol}: ${formatUsd(parseFloat(t.currentPrice))} &rarr; ${formatUsd(parseFloat(t.newPrice))}
          </div>
        ))}
      </div>
    </div>
  );
}
