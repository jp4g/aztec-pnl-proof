import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-neutral-100 bg-white py-6 mt-auto">
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between text-xs text-neutral-400">
        <p>
          Built on{" "}
          <Link href="https://aztec.network" target="_blank" className="hover:text-neutral-600 underline">
            Aztec
          </Link>
        </p>
        <Link href="https://github.com/jp4g/aztec-pnl-proof" target="_blank" className="hover:text-neutral-600">
          GitHub
        </Link>
      </div>
    </footer>
  );
}
