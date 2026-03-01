interface ProgressBarProps {
  progress: number; // 0-100
  complete?: boolean;
}

export default function ProgressBar({ progress, complete }: ProgressBarProps) {
  return (
    <div className="w-full bg-neutral-200 h-1.5 rounded-full overflow-hidden">
      <div
        className="bg-orange-500 h-full rounded-full relative overflow-hidden transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
      >
        {!complete && (
          <div className="absolute inset-0 bg-white/30 w-full h-full animate-shimmer" />
        )}
      </div>
    </div>
  );
}
