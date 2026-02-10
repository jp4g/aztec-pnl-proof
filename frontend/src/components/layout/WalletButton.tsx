"use client";

import { useState } from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import ConnectModal from "./ConnectModal";

function truncateAddress(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const STATUS_DOT: Record<string, string> = {
  disconnected: "bg-neutral-400",
  connecting: "bg-orange-400 animate-pulse",
  connected: "bg-green-500",
  error: "bg-red-500",
};

const STATUS_LABEL: Record<string, (addr: string | null) => string> = {
  disconnected: () => "Connect Wallet",
  connecting: () => "Connecting...",
  connected: (addr) => (addr ? truncateAddress(addr) : "Connected"),
  error: () => "Error",
};

export default function WalletButton() {
  const { status, address } = useAztecWallet();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-neutral-50 border border-neutral-200 rounded-full hover:bg-neutral-100 transition-colors cursor-pointer"
      >
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT[status]}`} />
        <span className="text-xs font-medium text-neutral-600">
          {STATUS_LABEL[status](address)}
        </span>
      </button>
      {modalOpen && <ConnectModal onClose={() => setModalOpen(false)} />}
    </>
  );
}
