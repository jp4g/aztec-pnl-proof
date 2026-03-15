import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { BatchCall, ContractFunctionInteraction, type SendInteractionOptions } from '@aztec/aztec.js/contracts';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { log } from './logger';

// The proof package uses moduleResolution: "NodeNext" while the frontend uses
// "bundler" (required by Next.js). TypeScript treats identical @aztec types from
// each resolution strategy as incompatible, even though they resolve to the same
// node_modules copy at runtime. We accept `unknown` here and cast once at the
// BatchCall call site so callers don't need ugly double-casts.
type WalletLike = unknown;

interface HasAddress {
    address: AztecAddress;
}

interface TokenLike extends HasAddress {
    methods: {
        mint_to_public(to: AztecAddress, amount: bigint): ContractFunctionInteraction;
    };
}

interface PriceFeedLike extends HasAddress {
    methods: {
        set_price(token: any, price: bigint): ContractFunctionInteraction;
    };
}

/**
 * Mutable pool state tracked by the caller.
 */
export interface PoolState {
    contract: HasAddress;
    token0: TokenLike;
    token1: TokenLike;
    reserve0: bigint;
    reserve1: bigint;
    decimals0: number;
    decimals1: number;
}

/**
 * Token with its target oracle price.
 */
export interface TokenPrice {
    token: HasAddress & { address: AztecAddress & { toField(): any } };
    price: bigint;
}

/**
 * Set oracle prices and rebalance AMM pools so the marginal swap price
 * matches the oracle price ratio.
 *
 * For each pool, this computes the target reserve ratio from oracle prices
 * and mints the deficit token directly to the pool. Since the AMM reads
 * reserves from token balances (no internal storage), this immediately
 * updates the effective price.
 *
 * Pool reserves are mutated in-place.
 */
export async function rebalancePools(params: {
    wallet: WalletLike;
    priceFeed: PriceFeedLike;
    minter: AztecAddress;
    pools: PoolState[];
    tokenPrices: TokenPrice[];
    setOracle?: boolean;
    sendOpts?: (from: AztecAddress) => SendInteractionOptions;
    onProgress?: (step: number, total: number, label: string) => void;
    /** Address string → display name, used in progress labels */
    tokenLabels?: Map<string, string>;
}): Promise<void> {
    const { wallet, priceFeed, minter, pools, tokenPrices, setOracle = true, onProgress, tokenLabels } = params;
    const opts = params.sendOpts ?? ((from: AztecAddress): SendInteractionOptions => ({ from }));

    // Build lookup: address string -> price
    const priceMap = new Map<string, bigint>();
    for (const tp of tokenPrices) {
        priceMap.set(tp.token.address.toString(), tp.price);
    }

    // Collect all interactions and deferred reserve mutations
    const interactions: ContractFunctionInteraction[] = [];
    const deferredMutations: (() => void)[] = [];

    // 1. Set oracle prices
    if (setOracle) {
        for (const tp of tokenPrices) {
            interactions.push(
                priceFeed.methods.set_price(tp.token.address.toField(), tp.price)
            );
        }
    }

    // 2. Compute rebalance mints
    for (const pool of pools) {
        const addr0 = pool.token0.address.toString();
        const addr1 = pool.token1.address.toString();
        const label0 = tokenLabels?.get(addr0) ?? addr0.slice(0, 10);
        const label1 = tokenLabels?.get(addr1) ?? addr1.slice(0, 10);
        const p0 = priceMap.get(addr0);
        const p1 = priceMap.get(addr1);
        if (p0 === undefined || p1 === undefined) {
            throw new Error(`Missing price for pool tokens: ${addr0}, ${addr1}`);
        }

        // AMM marginal price: reserve1/reserve0 = price0/price1
        // Normalize reserves to a common decimal base before comparing USD values,
        // since tokens have different decimals (e.g. USDC=6, wETH=9).
        const d0 = BigInt(pool.decimals0);
        const d1 = BigInt(pool.decimals1);
        const maxD = d0 > d1 ? d0 : d1;
        const norm0 = pool.reserve0 * 10n ** (maxD - d0);
        const norm1 = pool.reserve1 * 10n ** (maxD - d1);

        const value0 = norm0 * p0;
        const value1 = norm1 * p1;

        if (value0 > value1) {
            // Token0 side is overweight - mint token1 to balance
            const targetNorm1 = norm0 * p0 / p1;
            const targetR1 = targetNorm1 / 10n ** (maxD - d1);
            const toMint = targetR1 - pool.reserve1;
            if (toMint > 0n) {
                log(`  Rebalance pool(${label0}../${label1}..): mint ${toMint} of token1`);
                interactions.push(pool.token1.methods.mint_to_public(pool.contract.address, toMint));
                deferredMutations.push(() => { pool.reserve1 += toMint; });
            }
        } else if (value1 > value0) {
            // Token1 side is overweight - mint token0 to balance
            const targetNorm0 = norm1 * p1 / p0;
            const targetR0 = targetNorm0 / 10n ** (maxD - d0);
            const toMint = targetR0 - pool.reserve0;
            if (toMint > 0n) {
                log(`  Rebalance pool(${label0}../${label1}..): mint ${toMint} of token0`);
                interactions.push(pool.token0.methods.mint_to_public(pool.contract.address, toMint));
                deferredMutations.push(() => { pool.reserve0 += toMint; });
            }
        }
    }

    // Send interactions in batches of MAX_BATCH (entrypoint caps at 5, use 4 for safety)
    const MAX_BATCH = 4;
    const priceCount = setOracle ? tokenPrices.length : 0;
    const totalBatches = Math.ceil(interactions.length / MAX_BATCH);
    const totalSteps = totalBatches + 1; // +1 for final "Done" step

    onProgress?.(0, totalSteps, 'Preparing batches...');

    for (let i = 0; i < interactions.length; i += MAX_BATCH) {
        const batchIndex = i / MAX_BATCH;
        const batchEnd = Math.min(i + MAX_BATCH, interactions.length);

        // Determine what this batch contains based on the price/mint boundary
        const hasPrices = i < priceCount;
        const hasMints = batchEnd > priceCount;
        let label: string;
        if (hasPrices && hasMints) {
            label = `Batch ${batchIndex + 1}/${totalBatches}: setting prices & rebalancing...`;
        } else if (hasPrices) {
            label = `Batch ${batchIndex + 1}/${totalBatches}: setting prices...`;
        } else {
            label = `Batch ${batchIndex + 1}/${totalBatches}: rebalancing pools...`;
        }
        onProgress?.(batchIndex + 1, totalSteps, label);

        const chunk = interactions.slice(i, batchEnd);
        await new BatchCall(wallet as Wallet, chunk).send(opts(minter));
    }

    // Apply reserve mutations after successful send
    for (const mutate of deferredMutations) {
        mutate();
    }

    onProgress?.(totalSteps, totalSteps, 'Done');
}
