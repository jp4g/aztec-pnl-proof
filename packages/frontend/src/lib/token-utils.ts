import { POOL_ADDRESSES } from "@/config/contracts";

/**
 * Utility functions for token amount parsing and validation.
 */

/**
 * Convert a human-readable decimal string to a raw token amount (bigint)
 * given the token's decimal precision.
 */
export function toTokenAmount(amount: string, decimals: number): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded);
}

/**
 * Parse a formatted balance string (possibly containing commas) into a number.
 */
export function parseBalance(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

/**
 * Return true if the given string is a valid decimal number input
 * (digits with at most one decimal point).
 */
export function isValidAmount(value: string): boolean {
  return /^\d*\.?\d*$/.test(value);
}

/**
 * Format a raw token amount (bigint) to a human-readable string.
 */
export function formatTokenBalance(raw: bigint, decimals: number): string {
  const value = Number(raw) / 10 ** decimals;
  const displayDecimals = decimals <= 6 ? 2 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: displayDecimals,
    maximumFractionDigits: displayDecimals,
  });
}

/**
 * Look up the pool address for a token pair (all pools are paired with USDC).
 */
export function getPoolAddress(a: string, b: string): string | null {
  const nonUsdc = a === "USDC" ? b : a;
  return POOL_ADDRESSES[`${nonUsdc}/USDC`] ?? null;
}

/**
 * Truncate a hex address for display: "0x1234...abcd".
 */
export function truncateAddress(address: string, prefix = 6, suffix = 4): string {
  if (address.length <= prefix + suffix + 3) return address;
  return `${address.slice(0, prefix)}...${address.slice(-suffix)}`;
}
