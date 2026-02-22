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
  accounts: string[];
  status: WalletStatus;
  error: string | null;
  connect: () => Promise<void>;
  createAccount: () => Promise<void>;
  switchAccount: (address: string) => Promise<void>;
  removeAccount: (address: string) => Promise<void>;
  disconnect: () => void;
  clearAllSavedAccounts: () => void;
}

export const AztecWalletContext = createContext<AztecWalletContextValue | null>(
  null
);

const NODE_URL =
  process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

export function AztecWalletProvider({ children }: { children: ReactNode }) {
  const walletRef = useRef<EmbeddedAuditableWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
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
      // Must await — concurrent IDB writes from registerContract and
      // connectAllAccounts cause TransactionInactiveError
      await wallet.registerDeployedContracts().catch((err) =>
        console.warn("Contract registration failed:", err)
      );
      const { active, all } = await wallet.connectAllAccounts();
      setAccounts(all.map(a => a.toString()));

      if (active) {
        setAddress(active.toString());
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
      const addrStr = connectedAddress.toString();
      setAddress(addrStr);
      setAccounts(prev => [...prev, addrStr]);
      setStatus("connected");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create account";
      setError(message);
      setStatus("error");
    }
  }, [status, ensureWallet]);

  const switchAccount = useCallback(async (addr: string) => {
    if (!walletRef.current) return;
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");
    walletRef.current.switchAccount(AztecAddress.fromString(addr));
    setAddress(addr);
  }, []);

  const removeAccount = useCallback(async (addr: string) => {
    if (!walletRef.current) return;
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");
    walletRef.current.removeAccount(AztecAddress.fromString(addr));
    const remaining = walletRef.current.getAccountAddresses();
    setAccounts(remaining.map(a => a.toString()));
    const connected = walletRef.current.getConnectedAccount();
    if (connected) {
      setAddress(connected.toString());
    } else {
      setAddress(null);
      setStatus("no_account");
    }
  }, []);

  const disconnect = useCallback(() => {
    walletRef.current?.disconnect();
    walletRef.current = null;
    setAddress(null);
    setAccounts([]);
    setStatus("disconnected");
    setError(null);
  }, []);

  const clearAllSavedAccounts = useCallback(async () => {
    const { EmbeddedAuditableWallet } = await import("@/lib/embedded-wallet");
    EmbeddedAuditableWallet.clearAllSavedAccounts();
    walletRef.current = null;
    setAddress(null);
    setAccounts([]);
    setStatus("disconnected");
    setError(null);
  }, []);

  return (
    <AztecWalletContext.Provider
      value={{
        wallet: walletRef.current,
        address,
        accounts,
        status,
        error,
        connect,
        createAccount,
        switchAccount,
        removeAccount,
        disconnect,
        clearAllSavedAccounts,
      }}
    >
      {children}
    </AztecWalletContext.Provider>
  );
}
