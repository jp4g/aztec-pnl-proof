"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAztecWallet } from "@/hooks/useAztecWallet";

const MINTED_KEY = "privpnl-usdc-minted";

function loadMintedAddresses(): Set<string> {
  try {
    const raw = localStorage.getItem(MINTED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveMintedAddress(addr: string) {
  const set = loadMintedAddresses();
  set.add(addr);
  localStorage.setItem(MINTED_KEY, JSON.stringify([...set]));
}

export interface TokenContextValue {
  mintUsdc: () => Promise<void>;
  hasMintedUsdc: boolean;
  isMinting: boolean;
}

export const TokenContext = createContext<TokenContextValue | null>(null);

export function TokenProvider({ children }: { children: ReactNode }) {
  const { wallet, address, status } = useAztecWallet();

  const adminRef = useRef<import("@aztec/aztec.js/addresses").AztecAddress | null>(null);
  const adminRegistering = useRef(false);
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

  const registerAdmin = useCallback(async () => {
    if (adminRef.current || adminRegistering.current || !wallet) return;
    adminRegistering.current = true;
    try {
      const adminEnv = process.env.NEXT_PUBLIC_ADMIN_ACCOUNT;
      if (adminEnv) {
        // Devnet: use admin from env
        const { Fr, Fq } = await import("@aztec/aztec.js/fields");
        const parsed = JSON.parse(adminEnv) as { secretKey: string; salt: string; signingKey: string };
        adminRef.current = await wallet.registerAccountFromCredentials(
          Fr.fromString(parsed.secretKey),
          Fr.fromString(parsed.salt),
          Fq.fromString(parsed.signingKey),
        );
      } else {
        // Sandbox: use test accounts
        const { getInitialTestAccountsData } = await import(
          "@aztec/accounts/testing"
        );
        const testAccounts = await getInitialTestAccountsData();
        const admin = testAccounts[0];
        adminRef.current = await wallet.registerAccountFromCredentials(
          admin.secret,
          admin.salt,
          admin.signingKey
        );
      }
    } catch (err) {
      adminRegistering.current = false;
      console.warn("Failed to register admin account:", err);
    }
  }, [wallet]);

  // Register admin in background when wallet connects
  useEffect(() => {
    if (status === "connected" && wallet) {
      registerAdmin();
    }
  }, [status, wallet, registerAdmin]);

  // Reset admin ref when wallet disconnects
  useEffect(() => {
    if (status === "disconnected") {
      adminRef.current = null;
      adminRegistering.current = false;
    }
  }, [status]);

  const mintUsdc = useCallback(async () => {
    if (!wallet || !address) throw new Error("Wallet not connected");
    if (isMinting) return;

    setIsMinting(true);
    try {
      await registerAdmin();
      if (!adminRef.current) throw new Error("Admin account not available");

      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { Contract } = await import("@aztec/aztec.js/contracts");
      const { TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");

      const usdcAddressStr = process.env.NEXT_PUBLIC_TOKEN_USDC;
      if (!usdcAddressStr) throw new Error("NEXT_PUBLIC_TOKEN_USDC not set");

      const usdcAddress = AztecAddress.fromString(usdcAddressStr);
      const token = await Contract.at(usdcAddress, TokenContractArtifact, wallet);
      const recipient = AztecAddress.fromString(address);
      const amount = BigInt(100_000) * BigInt(10 ** 6); // 100,000 USDC (6 decimals)

      // On devnet, admin is an internal account so the wallet won't auto-inject FPC.
      let feeOpt: { paymentMethod: InstanceType<typeof import("@aztec/aztec.js/fee").SponsoredFeePaymentMethod> } | undefined;
      if (process.env.NEXT_PUBLIC_ADMIN_ACCOUNT) {
        const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
        const { getContractInstanceFromInstantiationParams } = await import("@aztec/aztec.js/contracts");
        const { SponsoredFPCContractArtifact } = await import("@aztec/noir-contracts.js/SponsoredFPC");
        const { SPONSORED_FPC_SALT } = await import("@aztec/constants");
        const { Fr: FrField } = await import("@aztec/aztec.js/fields");
        const fpcInstance = await getContractInstanceFromInstantiationParams(
          SponsoredFPCContractArtifact,
          { salt: new FrField(SPONSORED_FPC_SALT) },
        );
        feeOpt = { paymentMethod: new SponsoredFeePaymentMethod(fpcInstance.address) };
      }

      await token.methods
        .mint_to_private(recipient, amount)
        .send({ from: adminRef.current, fee: feeOpt });

      saveMintedAddress(address);
      setHasMintedUsdc(true);
    } finally {
      setIsMinting(false);
    }
  }, [wallet, address, isMinting, registerAdmin]);

  return (
    <TokenContext.Provider value={{ mintUsdc, hasMintedUsdc, isMinting }}>
      {children}
    </TokenContext.Provider>
  );
}
