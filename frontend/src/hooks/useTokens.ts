"use client";

import { useContext } from "react";
import { TokenContext, type TokenContextValue } from "@/contexts/TokenContext";

export function useTokens(): TokenContextValue {
  const ctx = useContext(TokenContext);
  if (!ctx) {
    throw new Error("useTokens must be used within TokenProvider");
  }
  return ctx;
}
