"use client";

import {
  createContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EmbeddedAuditableWallet } from "@/lib/embedded-wallet";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "no_account" | "creating" | "error";

export interface AztecWalletContextValue {
  wallet: EmbeddedAuditableWallet | null;
  address: string | null;
  status: WalletStatus;
  error: string | null;
  connect: () => Promise<void>;
  createAccount: () => Promise<void>;
  disconnect: () => void;
  clearSavedAccount: () => void;
}

export const AztecWalletContext = createContext<AztecWalletContextValue | null>(
  null
);

const NODE_URL =
  process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

export function AztecWalletProvider({ children }: { children: ReactNode }) {
  const walletRef = useRef<EmbeddedAuditableWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);

  const ensureWallet = useCallback(async () => {
    const { EmbeddedAuditableWallet } = await import("@/lib/embedded-wallet");
    if (!walletRef.current) {
      walletRef.current = await EmbeddedAuditableWallet.initialize(NODE_URL);
    }
    return walletRef.current;
  }, []);

  const connect = useCallback(async () => {
    if (status === "connecting") return;
    setStatus("connecting");
    setError(null);

    try {
      const wallet = await ensureWallet();
      const connectedAddress = await wallet.connectExistingAccount();

      if (connectedAddress) {
        setAddress(connectedAddress.toString());
        setStatus("connected");
      } else {
        setStatus("no_account");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect wallet";
      setError(message);
      setStatus("error");
    }
  }, [status, ensureWallet]);

  const createAccount = useCallback(async () => {
    if (status === "creating") return;
    setStatus("creating");
    setError(null);

    try {
      const wallet = await ensureWallet();
      const connectedAddress = await wallet.createAccountAndConnect();
      setAddress(connectedAddress.toString());
      setStatus("connected");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create account";
      setError(message);
      setStatus("error");
    }
  }, [status, ensureWallet]);

  const disconnect = useCallback(() => {
    walletRef.current?.disconnect();
    walletRef.current = null;
    setAddress(null);
    setStatus("disconnected");
    setError(null);
  }, []);

  const clearSavedAccount = useCallback(async () => {
    const { EmbeddedAuditableWallet } = await import("@/lib/embedded-wallet");
    EmbeddedAuditableWallet.clearSavedAccount();
    walletRef.current = null;
    setAddress(null);
    setStatus("disconnected");
    setError(null);
  }, []);

  return (
    <AztecWalletContext.Provider
      value={{
        wallet: walletRef.current,
        address,
        status,
        error,
        connect,
        createAccount,
        disconnect,
        clearSavedAccount,
      }}
    >
      {children}
    </AztecWalletContext.Provider>
  );
}
