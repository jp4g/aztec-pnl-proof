import Link from "next/link";

const STEPS = [
  {
    number: "1",
    title: "Trade privately",
    description:
      "Swap tokens on a private DEX built on Aztec. Your trades, balances, and positions stay encrypted on-chain.",
  },
  {
    number: "2",
    title: "Disclose selectively",
    description:
      "Share your tagging key with an auditor to disclose all encrypted swaps you intend to prove, without revealing anything else about what assets you held or what swaps you did.",
  },
  {
    number: "3",
    title: "Prove in zero knowledge",
    description:
      "Prove each of your swaps in ZK circuits to aggregate your total PnL or tax obligation into a final proof — selectively disclose how much you made without disclosing how you made it!",
  },
] as const;

const USE_CASES = [
  {
    title: "Tax reporting",
    description:
      "Prove your capital gains or losses to a tax authority without exposing your portfolio or trading strategy.",
  },
  {
    title: "Fund compliance",
    description:
      "Show auditors that a fund's reported PnL is accurate without revealing positions or counterparties.",
  },
  {
    title: "Reputation",
    description:
      "Prove you're a profitable trader on-chain without doxxing your alpha.",
  },
] as const;

export default function Home() {
  return (
    <main className="flex-grow w-full">
      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="w-14 h-14 bg-orange-500 rounded-full flex items-center justify-center text-white text-xl font-bold mx-auto mb-6">
          P
        </div>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-neutral-900 mb-4">
          Prove your PnL, keep your privacy
        </h1>
        <p className="text-neutral-500 max-w-xl mx-auto mb-8 leading-relaxed text-lg">
          Generate a zero-knowledge proof of your trading profit &amp; loss —
          without revealing any of your assets, trades, or balances.
        </p>
        <div className="flex justify-center gap-4">
          <Link
            href="/prove"
            className="px-6 py-3 bg-orange-600 text-white text-sm font-medium rounded-xl hover:bg-orange-700 transition-colors"
          >
            Generate Proof
          </Link>
          <Link
            href="/trade"
            className="px-6 py-3 bg-neutral-900 text-white text-sm font-medium rounded-xl hover:bg-neutral-800 transition-colors"
          >
            Try the DEX
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-semibold text-neutral-900 mb-10 text-center">
          How it works
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          {STEPS.map((step) => (
            <div key={step.number} className="text-center">
              <div className="w-10 h-10 rounded-full bg-orange-100 text-orange-600 font-semibold text-sm flex items-center justify-center mx-auto mb-4">
                {step.number}
              </div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-2">
                {step.title}
              </h3>
              <p className="text-sm text-neutral-500 leading-relaxed">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="max-w-4xl mx-auto px-6">
        <hr className="border-neutral-100" />
      </div>

      {/* Use cases */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-semibold text-neutral-900 mb-10 text-center">
          Why prove your PnL privately?
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          {USE_CASES.map((uc) => (
            <div
              key={uc.title}
              className="rounded-2xl border border-neutral-200 bg-white p-6"
            >
              <h3 className="text-sm font-semibold text-neutral-900 mb-2">
                {uc.title}
              </h3>
              <p className="text-sm text-neutral-500 leading-relaxed">
                {uc.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Proof of concept callout */}
      <section className="max-w-4xl mx-auto px-6 pb-24">
        <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-8 text-center">
          <p className="text-sm text-neutral-500 leading-relaxed max-w-lg mx-auto">
            PrivPNL is a proof of concept built on{" "}
            <Link
              href="https://aztec.network"
              target="_blank"
              className="text-orange-600 hover:text-orange-700 underline"
            >
              Aztec
            </Link>
            . All proofs are generated locally in your browser. This is not
            financial software — it&apos;s a demonstration of what private DeFi
            compliance can look like.
          </p>
        </div>
      </section>
    </main>
  );
}
