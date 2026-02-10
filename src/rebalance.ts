import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { TokenContract } from '@aztec/noir-contracts.js/Token';
import type { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed';
import type { AMMContract } from './artifacts/AMM';

/**
 * Mutable pool state tracked by the caller.
 */
export interface PoolState {
    contract: AMMContract;
    token0: TokenContract;
    token1: TokenContract;
    reserve0: bigint;
    reserve1: bigint;
}

/**
 * Token with its target oracle price.
 */
export interface TokenPrice {
    token: TokenContract;
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
    priceFeed: PriceFeedContract;
    minter: AztecAddress;
    pools: PoolState[];
    tokenPrices: TokenPrice[];
    setOracle?: boolean;
}): Promise<void> {
    const { priceFeed, minter, pools, tokenPrices, setOracle = true } = params;

    // Build lookup: address string -> price
    const priceMap = new Map<string, bigint>();
    for (const tp of tokenPrices) {
        priceMap.set(tp.token.address.toString(), tp.price);
    }

    // 1. Set oracle prices
    if (setOracle) {
        for (const tp of tokenPrices) {
            await priceFeed.methods
                .set_price(tp.token.address.toField(), tp.price)
                .send({ from: minter })
                .wait();
        }
    }

    // 2. Rebalance each pool
    for (const pool of pools) {
        const addr0 = pool.token0.address.toString();
        const addr1 = pool.token1.address.toString();
        const p0 = priceMap.get(addr0);
        const p1 = priceMap.get(addr1);
        if (p0 === undefined || p1 === undefined) {
            throw new Error(`Missing price for pool tokens: ${addr0}, ${addr1}`);
        }

        // AMM marginal price: reserve1/reserve0 = price0/price1
        // Equivalently: reserve0 * price0 == reserve1 * price1
        const value0 = pool.reserve0 * p0;
        const value1 = pool.reserve1 * p1;

        if (value0 > value1) {
            // Token0 side is overweight - mint token1 to balance
            const targetR1 = pool.reserve0 * p0 / p1;
            const toMint = targetR1 - pool.reserve1;
            if (toMint > 0n) {
                console.log(`  Rebalance pool(${addr0.slice(0, 10)}../${addr1.slice(0, 10)}..): mint ${toMint} of token1`);
                await pool.token1.methods
                    .mint_to_public(pool.contract.address, toMint)
                    .send({ from: minter })
                    .wait();
                pool.reserve1 += toMint;
            }
        } else if (value1 > value0) {
            // Token1 side is overweight - mint token0 to balance
            const targetR0 = pool.reserve1 * p1 / p0;
            const toMint = targetR0 - pool.reserve0;
            if (toMint > 0n) {
                console.log(`  Rebalance pool(${addr0.slice(0, 10)}../${addr1.slice(0, 10)}..): mint ${toMint} of token0`);
                await pool.token0.methods
                    .mint_to_public(pool.contract.address, toMint)
                    .send({ from: minter })
                    .wait();
                pool.reserve0 += toMint;
            }
        }
    }
}
