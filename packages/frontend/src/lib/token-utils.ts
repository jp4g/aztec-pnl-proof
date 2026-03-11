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
