import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import { AztecWalletProvider } from "@/contexts/AztecWalletContext";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "PrivDex - Private PnL Proof",
  description: "Generate Zero-Knowledge proofs of your trading PnL",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans bg-neutral-50 text-neutral-800 antialiased selection:bg-orange-100 selection:text-orange-600 min-h-screen flex flex-col`}
      >
        <AztecWalletProvider>
          <Navbar />
          {children}
          <Footer />
        </AztecWalletProvider>
      </body>
    </html>
  );
}
