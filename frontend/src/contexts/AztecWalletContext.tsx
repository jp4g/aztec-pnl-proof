"use client";

import {
  createContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EmbeddedWallet } from "@/lib/embedded-wallet";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

export interface AztecWalletContextValue {
  wallet: EmbeddedWallet | null;
  address: string | null;
  status: WalletStatus;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export const AztecWalletContext = createContext<AztecWalletContextValue | null>(
  null
);

const NODE_URL =
  process.env.NEXT_PUBLIC_AZTEC_NODE_URL ?? "http://localhost:8080";

export function AztecWalletProvider({ children }: { children: ReactNode }) {
  const walletRef = useRef<EmbeddedWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (status === "connecting") return;
    setStatus("connecting");
    setError(null);

    try {
      // Lazy-load the wallet module (pulls in PXE + WASM)
      const { EmbeddedWallet } = await import("@/lib/embedded-wallet");

      // Initialize PXE on first connect
      if (!walletRef.current) {
        walletRef.current = await EmbeddedWallet.initialize(NODE_URL);
      }

      const wallet = walletRef.current;

      // Try restoring an existing account, otherwise create a new one
      let connectedAddress =
        (await wallet.connectExistingAccount()) ??
        (await wallet.createAccountAndConnect());

      setAddress(connectedAddress.toString());
      setStatus("connected");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect wallet";
      setError(message);
      setStatus("error");
    }
  }, [status]);

  const disconnect = useCallback(() => {
    walletRef.current?.disconnect();
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
        disconnect,
      }}
    >
      {children}
    </AztecWalletContext.Provider>
  );
}
