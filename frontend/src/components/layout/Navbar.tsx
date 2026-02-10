"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import WalletButton from "./WalletButton";

const NAV_LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/prove", label: "Prove PnL" },
] as const;

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="w-full bg-white border-b border-neutral-100 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tighter text-neutral-900 flex items-center gap-2"
          >
            <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold">
              P
            </div>
            PRIVDEX
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-neutral-500">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? "text-orange-600 cursor-default"
                      : "hover:text-neutral-900 transition-colors"
                  }
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <WalletButton />
          <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-neutral-100 text-neutral-500 transition-colors">
            <Icon icon="solar:settings-linear" width={20} />
          </button>
        </div>
      </div>
    </nav>
  );
}
