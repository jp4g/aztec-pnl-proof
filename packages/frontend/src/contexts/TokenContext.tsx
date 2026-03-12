"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";
import { useAdminAccount } from "@/hooks/useAdminAccount";
import { buildSponsoredFeePaymentMethod } from "@/lib/fee-utils";
import { loadMintedAddresses, saveMintedAddress } from "@/lib/storage";

export interface TokenContextValue {
  mintUsdc: () => Promise<void>;
  hasMintedUsdc: boolean;
  isMinting: boolean;
}

export const TokenContext = createContext<TokenContextValue | null>(null);

export function TokenProvider({ children }: { children: ReactNode }) {
  const { wallet, address, status } = useAztecWallet();
  const { adminRef, ensureAdmin, resetAdmin } = useAdminAccount(wallet);

  const [isMinting, setIsMinting] = useState(false);
  const [hasMintedUsdc, setHasMintedUsdc] = useState(false);

  // Check localStorage when address changes
  useEffect(() => {
    if (address) {
      setHasMintedUsdc(loadMintedAddresses().has(address));
    } else {
      setHasMintedUsdc(false);
    }
  }, [address]);

  // Register admin in background when wallet connects
  useEffect(() => {
    if (status === "connected" && wallet) {
      ensureAdmin();
    }
  }, [status, wallet, ensureAdmin]);

  // Reset admin ref when wallet disconnects
  useEffect(() => {
    if (status === "disconnected") {
      resetAdmin();
    }
  }, [status, resetAdmin]);

  const mintUsdc = useCallback(async () => {
    if (!wallet || !address) throw new Error("Wallet not connected");
    if (isMinting) return;

    setIsMinting(true);
    try {
      await ensureAdmin();
      if (!adminRef.current) throw new Error("Admin account not available");

      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");

      const usdcAddressStr = process.env.NEXT_PUBLIC_TOKEN_USDC;
      if (!usdcAddressStr) throw new Error("NEXT_PUBLIC_TOKEN_USDC not set");

      const usdcAddress = AztecAddress.fromString(usdcAddressStr);
      const token = await Contract.at(usdcAddress, TokenContractArtifact, wallet);
      const recipient = AztecAddress.fromString(address);
      const amount = 100_000n * 10n ** 6n; // 100,000 USDC (6 decimals)

      // On devnet, admin is an internal account so the wallet won't auto-inject FPC.
      const paymentMethod = await buildSponsoredFeePaymentMethod();
      const feeOpt = paymentMethod ? { paymentMethod } : undefined;

      await token.methods
        .mint_to_private(recipient, amount)
        .send({ from: adminRef.current, fee: feeOpt });

      saveMintedAddress(address);
      setHasMintedUsdc(true);
    } finally {
      setIsMinting(false);
    }
  }, [wallet, address, isMinting, ensureAdmin]);

  return (
    <TokenContext.Provider value={{ mintUsdc, hasMintedUsdc, isMinting }}>
      {children}
    </TokenContext.Provider>
  );
}
