import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";

/**
 * Build a SponsoredFeePaymentMethod for devnet transactions.
 *
 * Both PriceCard (rebalance) and TokenProvider (USDC minting) use this
 * to get the FPC payment method from the env-configured address.
 *
 * Returns `undefined` when not on devnet (NEXT_PUBLIC_ADMIN_ACCOUNT absent).
 * Throws if NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is not set.
 */
export async function buildSponsoredFeePaymentMethod(): Promise<SponsoredFeePaymentMethod | undefined> {
  if (!process.env.NEXT_PUBLIC_ADMIN_ACCOUNT) return undefined;

  const fpcAddress = process.env.NEXT_PUBLIC_SPONSORED_FPC_ADDRESS;
  if (!fpcAddress) {
    throw new Error('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is required. Run `yarn deploy` or `yarn fpc:deploy` first.');
  }

  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  return new SponsoredFeePaymentMethod(AztecAddress.fromString(fpcAddress));
}
