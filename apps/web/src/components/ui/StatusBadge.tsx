"use client";

import { ProofStatus } from "@/types";

const STATUS_STYLES: Record<
  ProofStatus,
  { bg: string; text: string; dot: string; border: string; extra?: string }
> = {
  proven: {
    bg: "bg-green-50",
    text: "text-green-700",
    dot: "bg-green-500",
    border: "border-green-100",
  },
  proving: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    dot: "bg-blue-500 animate-ping",
    border: "border-blue-100",
    extra: "animate-pulse",
  },
  pending: {
    bg: "bg-neutral-100",
    text: "text-neutral-500",
    dot: "bg-neutral-400",
    border: "border-neutral-200",
  },
  unused: {
    bg: "bg-neutral-100",
    text: "text-neutral-400",
    dot: "bg-neutral-300",
    border: "border-neutral-200",
  },
};

const STATUS_LABELS: Record<ProofStatus, string> = {
  proven: "Proven",
  proving: "Proving...",
  pending: "Pending",
  unused: "Unused",
};

interface StatusBadgeProps {
  status: ProofStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const style = STATUS_STYLES[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text} border ${style.border} ${style.extra ?? ""}`}
    >
      <div className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {STATUS_LABELS[status]}
    </span>
  );
}
