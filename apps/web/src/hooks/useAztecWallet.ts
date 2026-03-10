"use client";

import { useContext } from "react";
import {
  AztecWalletContext,
  type AztecWalletContextValue,
} from "@/contexts/AztecWalletContext";

export function useAztecWallet(): AztecWalletContextValue {
  const ctx = useContext(AztecWalletContext);
  if (!ctx) {
    throw new Error("useAztecWallet must be used within AztecWalletProvider");
  }
  return ctx;
}
