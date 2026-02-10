import Link from "next/link";

export default function Home() {
  return (
    <main className="flex-grow max-w-6xl mx-auto px-6 py-24 w-full flex flex-col items-center justify-center text-center">
      <div className="w-16 h-16 bg-orange-500 rounded-full flex items-center justify-center text-white text-2xl font-bold mb-8">
        P
      </div>
      <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 mb-4">
        Welcome to PrivDex
      </h1>
      <p className="text-neutral-500 max-w-md mb-8 leading-relaxed">
        The privacy-first decentralized exchange. Trade, provide liquidity, and
        prove your PnL with Zero-Knowledge proofs.
      </p>
      <div className="flex gap-4">
        <Link
          href="/trade"
          className="px-6 py-3 bg-neutral-900 text-white text-sm font-medium rounded-xl hover:bg-neutral-800 transition-colors"
        >
          Start Trading
        </Link>
        <Link
          href="/prove"
          className="px-6 py-3 bg-orange-600 text-white text-sm font-medium rounded-xl hover:bg-orange-700 transition-colors"
        >
          Prove PnL
        </Link>
      </div>
    </main>
  );
}
