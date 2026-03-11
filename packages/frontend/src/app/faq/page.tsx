"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";

interface FaqEntry {
  question: string;
  answer: string;
}

const FAQ_ENTRIES: FaqEntry[] = [
  {
    question: "What is PrivPNL?",
    answer:
      "PrivPNL is a proof-of-concept application that demonstrates private PnL (profit and loss) proofs on Aztec. It lets you trade on a private DEX and then generate a zero-knowledge proof of your realized PnL — without revealing any individual trades, balances, or positions.",
  },
  {
    question: "How does private trading work?",
    answer:
      "Trades happen on Aztec, a Layer 2 with native privacy. When you swap tokens, the details (amounts, assets, counterparties) are encrypted on-chain. Only you can decrypt your own transaction history using your private keys.",
  },
  {
    question: "What does the PnL proof actually prove?",
    answer:
      "The proof attests to a specific net realized PnL figure computed from your swap history. A verifier can confirm the number is correct without learning which tokens you traded, how much you traded, or when.",
  },
  {
    question: "Who would verify this proof?",
    answer:
      "Anyone you share it with — a tax authority, an auditor, a fund administrator, or an on-chain protocol that gates access based on trading performance. The proof is a standalone artifact that can be verified independently.",
  },
  {
    question: "Where is the proof generated?",
    answer:
      "Entirely in your browser. Your private keys never leave your device. The ZK circuit runs client-side using WebAssembly, so no server ever sees your decrypted trade data.",
  },
  {
    question: "Is this production-ready?",
    answer:
      "No. PrivPNL is a proof of concept built to demonstrate what private DeFi compliance could look like. The circuits, contracts, and frontend are functional but have not been audited. Do not use this with real funds.",
  },
  {
    question: "What is Aztec?",
    answer:
      "Aztec is a privacy-first Layer 2 on Ethereum. It supports private smart contracts where state is encrypted by default. PrivPNL uses Aztec's private token standard and AMM contracts for trading.",
  },
  {
    question: "How is PnL calculated?",
    answer:
      "PnL is computed using a FIFO (first-in, first-out) cost basis method across all your swaps. Each sell is matched against the earliest unsold buy lots to determine realized gains or losses, denominated in USDC.",
  },
];

function FaqItem({ entry }: { entry: FaqEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-neutral-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left group"
      >
        <span className="text-sm font-medium text-neutral-900 group-hover:text-orange-600 transition-colors">
          {entry.question}
        </span>
        <Icon
          icon={open ? "solar:minus-circle-linear" : "solar:add-circle-linear"}
          width={20}
          className="text-neutral-400 group-hover:text-orange-500 transition-colors flex-shrink-0 ml-4"
        />
      </button>
      {open && (
        <div className="pb-5 pr-10">
          <p className="text-sm text-neutral-500 leading-relaxed">
            {entry.answer}
          </p>
        </div>
      )}
    </div>
  );
}

export default function FaqPage() {
  return (
    <main className="flex-grow max-w-2xl mx-auto px-6 py-16 w-full">
      <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 mb-2">
        FAQ
      </h1>
      <p className="text-neutral-500 text-sm mb-10">
        Common questions about PrivPNL and private PnL proofs.
      </p>
      <div className="rounded-2xl border border-neutral-200 bg-white px-6">
        {FAQ_ENTRIES.map((entry) => (
          <FaqItem key={entry.question} entry={entry} />
        ))}
      </div>
    </main>
  );
}
