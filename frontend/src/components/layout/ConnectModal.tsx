"use client";

import { useAztecWallet } from "@/hooks/useAztecWallet";
import { Icon } from "@iconify/react";
import { useState } from "react";

interface ConnectModalProps {
  onClose: () => void;
}

export default function ConnectModal({ onClose }: ConnectModalProps) {
  const { status, address, error, connect, disconnect } = useAztecWallet();
  const [copied, setCopied] = useState(false);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600 transition-colors"
        >
          <Icon icon="solar:close-circle-linear" width={20} />
        </button>

        <h2 className="text-lg font-semibold text-neutral-900 mb-1">
          Aztec Wallet
        </h2>
        <p className="text-xs text-neutral-400 mb-6">
          Connect to the Aztec network
        </p>

        {/* Error banner */}
        {status === "error" && error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-100">
            <p className="text-xs text-red-600 break-all">{error}</p>
          </div>
        )}

        {/* Disconnected state */}
        {status === "disconnected" && (
          <button
            onClick={connect}
            className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium transition-colors cursor-pointer"
          >
            Connect Wallet
          </button>
        )}

        {/* Connecting state */}
        {status === "connecting" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-neutral-500">Initializing PXE...</p>
            <p className="text-xs text-neutral-400">
              This may take up to 60 seconds
            </p>
          </div>
        )}

        {/* Connected state */}
        {status === "connected" && address && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-neutral-50 border border-neutral-200">
              <div className="w-2 h-2 bg-green-500 rounded-full shrink-0" />
              <span className="text-xs font-mono text-neutral-600 break-all flex-1">
                {address}
              </span>
              <button
                onClick={copyAddress}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-neutral-200 text-neutral-400 hover:text-neutral-600 transition-colors"
              >
                <Icon
                  icon={
                    copied
                      ? "solar:check-circle-linear"
                      : "solar:copy-linear"
                  }
                  width={16}
                />
              </button>
            </div>
            <button
              onClick={() => {
                disconnect();
                onClose();
              }}
              className="w-full py-2.5 rounded-xl border border-neutral-200 text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors cursor-pointer"
            >
              Disconnect
            </button>
          </div>
        )}

        {/* Error state with retry */}
        {status === "error" && (
          <button
            onClick={connect}
            className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium transition-colors cursor-pointer"
          >
            Retry Connection
          </button>
        )}
      </div>
    </div>
  );
}
