import Link from "next/link";

const FOOTER_LINKS = [
  { href: "#", label: "Documentation" },
  { href: "#", label: "Proof Verifier" },
  { href: "#", label: "Status" },
] as const;

export default function Footer() {
  return (
    <footer className="border-t border-neutral-100 bg-white py-8 mt-auto">
      <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between text-xs text-neutral-400">
        <p>&copy; 2023 PrivDex Inc. All computations are performed locally.</p>
        <div className="flex items-center gap-6 mt-4 md:mt-0">
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="hover:text-neutral-600"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
