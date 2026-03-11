"use client";

import { type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { useAztecWallet } from "@/hooks/useAztecWallet";

export default function RequireWallet({ children }: { children: ReactNode }) {
  const { status } = useAztecWallet();

  if (status !== "connected") {
    return (
      <main className="flex-grow flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center mx-auto mb-4">
            <Icon icon="lucide:lock-keyhole" width={28} className="text-orange-500" />
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 mb-2">Connect your wallet</h2>
          <p className="text-sm text-neutral-500">
            Sign in with your wallet to access this page.
          </p>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
