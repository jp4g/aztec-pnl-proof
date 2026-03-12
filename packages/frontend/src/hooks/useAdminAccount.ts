"use client";

import { useCallback, useRef } from "react";
import type { EmbeddedAuditableWallet } from "@/lib/embedded-wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";

/**
 * Shared hook that handles admin account registration.
 *
 * Both PriceCard (price oracle updates) and TokenProvider (USDC minting)
 * need to register the admin account before sending admin-only transactions.
 * This hook deduplicates that logic.
 */
export function useAdminAccount(wallet: EmbeddedAuditableWallet | null) {
  const adminRef = useRef<AztecAddress | null>(null);
  const adminRegistering = useRef(false);

  const ensureAdmin = useCallback(async (): Promise<AztecAddress | null> => {
    if (adminRef.current) return adminRef.current;
    if (!wallet) return null;

    if (adminRegistering.current) {
      // Wait for ongoing registration
      while (adminRegistering.current) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return adminRef.current;
    }

    adminRegistering.current = true;
    try {
      const adminEnv = process.env.NEXT_PUBLIC_ADMIN_ACCOUNT;
      if (adminEnv) {
        const { Fr, Fq } = await import("@aztec/aztec.js/fields");
        const parsed = JSON.parse(adminEnv) as { secretKey: string; salt: string; signingKey: string };
        adminRef.current = await wallet.registerAccountFromCredentials(
          Fr.fromString(parsed.secretKey),
          Fr.fromString(parsed.salt),
          Fq.fromString(parsed.signingKey),
        );
      }
    } catch (err) {
      console.warn("Failed to register admin account:", err);
    } finally {
      adminRegistering.current = false;
    }

    return adminRef.current;
  }, [wallet]);

  /** Reset refs on disconnect */
  const resetAdmin = useCallback(() => {
    adminRef.current = null;
    adminRegistering.current = false;
  }, []);

  return { adminRef, ensureAdmin, resetAdmin };
}
