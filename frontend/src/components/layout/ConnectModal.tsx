"use client";

import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useTokens } from "@/hooks/useTokens";
import { useToast } from "@/hooks/useToast";
import { Icon } from "@iconify/react";
import { useState } from "react";

interface ConnectModalProps {
  onClose: () => void;
}

export default function ConnectModal({ onClose }: ConnectModalProps) {
  const { status, address, accounts, error, connect, createAccount, switchAccount, removeAccount, disconnect, clearAllSavedAccounts, isDemoAccount } = useAztecWallet();
  const { mintUsdc, hasMintedUsdc, isMinting } = useTokens();
  const { showToast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const handleMint = async () => {
    try {
      await mintUsdc();
      showToast("Minted 100,000 USDC", "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to mint USDC",
        "error"
      );
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const copyAddress = async (addr: string) => {
    await navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  };

  const truncateAddress = (addr: string) => {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
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

        {/* No account found */}
        {status === "no_account" && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
              <p className="text-xs text-amber-700">No accounts found. Create one to get started.</p>
            </div>
            <button
              onClick={createAccount}
              className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Create Account
            </button>
          </div>
        )}

        {/* Creating account */}
        {status === "creating" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-neutral-500">Creating account...</p>
            <p className="text-xs text-neutral-400">
              Deploying via sponsored FPC
            </p>
          </div>
        )}

        {/* Connected state — account list */}
        {status === "connected" && address && (
          <div className="space-y-4">
            {/* Account list */}
            <div className="rounded-lg border border-neutral-200 divide-y divide-neutral-100">
              {accounts.map((acc) => {
                const isActive = acc === address;
                const isDemo = isDemoAccount(acc);
                return (
                  <div
                    key={acc}
                    onClick={() => {
                      if (!isActive) switchAccount(acc);
                    }}
                    className={`w-full flex items-center gap-2 p-3 text-left transition-colors ${
                      isDemo
                        ? isActive ? "bg-amber-50/50" : "bg-amber-50/30 hover:bg-amber-50/50 cursor-pointer"
                        : isActive ? "bg-neutral-50" : "hover:bg-neutral-50 cursor-pointer"
                    }`}
                  >
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isActive ? "bg-green-500" : "bg-neutral-300"
                      }`}
                    />
                    <span className="text-xs font-mono text-neutral-600 flex-1 truncate">
                      {truncateAddress(acc)}
                    </span>
                    {isDemo && (
                      <span className="text-[10px] font-medium text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full shrink-0">
                        Demo
                      </span>
                    )}
                    {isActive && (
                      <Icon
                        icon="solar:check-circle-linear"
                        width={16}
                        className="text-green-500 shrink-0"
                      />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copyAddress(acc);
                      }}
                      className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-neutral-200 text-neutral-400 hover:text-neutral-600 transition-colors"
                    >
                      <Icon
                        icon={
                          copied === acc
                            ? "solar:check-circle-linear"
                            : "solar:copy-linear"
                        }
                        width={14}
                      />
                    </button>
                    {!isDemo && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmRemove(acc);
                        }}
                        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-red-100 text-neutral-400 hover:text-red-500 transition-colors"
                      >
                        <Icon icon="solar:trash-bin-minimalistic-linear" width={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Mint USDC */}
            {!hasMintedUsdc && (
              <button
                onClick={handleMint}
                disabled={isMinting}
                className="w-full py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:bg-indigo-300 text-white text-sm font-medium transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              >
                {isMinting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Minting...
                  </>
                ) : (
                  <>
                    <Icon icon="solar:wallet-money-linear" width={16} />
                    Mint 100,000 USDC
                  </>
                )}
              </button>
            )}

            {/* Create new account */}
            <button
              onClick={createAccount}
              className="w-full py-2.5 rounded-xl border border-dashed border-neutral-300 text-sm font-medium text-neutral-500 hover:text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
            >
              <Icon icon="solar:add-circle-linear" width={16} />
              Create New Account
            </button>

            {/* Disconnect */}
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
          <div className="space-y-2">
            <button
              onClick={connect}
              className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Retry Connection
            </button>
            <button
              onClick={() => { clearAllSavedAccounts(); }}
              className="w-full py-2.5 rounded-xl border border-neutral-200 text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors cursor-pointer"
            >
              Clear Saved Accounts
            </button>
          </div>
        )}
      </div>

      {/* Remove account confirmation modal */}
      {confirmRemove && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs mx-4 p-6">
            <h3 className="text-base font-semibold text-neutral-900 mb-2">
              Remove Account
            </h3>
            <p className="text-sm text-neutral-500 mb-1">
              Are you sure you want to remove this account?
            </p>
            <p className="text-xs font-mono text-neutral-400 mb-6 break-all">
              {truncateAddress(confirmRemove)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmRemove(null)}
                className="flex-1 py-2.5 rounded-xl border border-neutral-200 text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors cursor-pointer"
              >
                No
              </button>
              <button
                onClick={() => {
                  removeAccount(confirmRemove);
                  setConfirmRemove(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors cursor-pointer"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
