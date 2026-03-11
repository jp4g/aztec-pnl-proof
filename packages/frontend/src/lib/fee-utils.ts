import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";

/**
 * Build a SponsoredFeePaymentMethod for devnet transactions.
 *
 * Both PriceCard (rebalance) and TokenProvider (USDC minting) derive
 * the FPC address identically. This utility deduplicates that logic.
 *
 * Returns `undefined` when not on devnet (NEXT_PUBLIC_ADMIN_ACCOUNT absent).
 */
export async function buildSponsoredFeePaymentMethod(): Promise<SponsoredFeePaymentMethod | undefined> {
  if (!process.env.NEXT_PUBLIC_ADMIN_ACCOUNT) return undefined;

  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec/aztec.js/contracts");
  const { SponsoredFPCContractArtifact } = await import("@aztec/noir-contracts.js/SponsoredFPC");
  const { SPONSORED_FPC_SALT } = await import("@aztec/constants");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const fpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  return new SponsoredFeePaymentMethod(fpcInstance.address);
}

/**
 * Build send options that include sponsored fee payment on devnet.
 * On sandbox (no NEXT_PUBLIC_ADMIN_ACCOUNT) the returned opts only contain `from`.
 */
export async function buildSendOpts(
  from: AztecAddress,
): Promise<Record<string, unknown>> {
  const paymentMethod = await buildSponsoredFeePaymentMethod();
  if (paymentMethod) {
    return { from, fee: { paymentMethod } };
  }
  return { from };
}
