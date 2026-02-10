import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed';
import { AMMContract } from '../src/artifacts/AMM';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import { Fr } from '@aztec/foundation/curves/bn254';
import { rebalancePools, type PoolState } from '../src/rebalance';

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Pool Rebalancer", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let tokenA: TokenContract;
    let tokenB: TokenContract;
    let tokenC: TokenContract;
    let lpAB: TokenContract;
    let lpAC: TokenContract;
    let poolAB: AMMContract;
    let poolAC: AMMContract;
    let priceFeed: PriceFeedContract;

    const DECIMALS = 9n;

    before(async () => {
        node = createAztecNodeClient(AZTEC_NODE_URL);

        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false });

        const accounts = await getInitialTestAccountsData();
        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }

        // Deploy PriceFeed
        priceFeed = await PriceFeedContract.deploy(wallet).send({ from: addresses[0] }).deployed();

        // Deploy tokens
        tokenA = await TokenContract.deploy(wallet, addresses[0], "Token A", "TKA", 18).send({ from: addresses[0] }).deployed();
        tokenB = await TokenContract.deploy(wallet, addresses[0], "Token B", "TKB", 18).send({ from: addresses[0] }).deployed();
        tokenC = await TokenContract.deploy(wallet, addresses[0], "Token C", "TKC", 18).send({ from: addresses[0] }).deployed();

        // Deploy LP tokens
        lpAB = await TokenContract.deploy(wallet, addresses[0], "LP AB", "LPAB", 18).send({ from: addresses[0] }).deployed();
        lpAC = await TokenContract.deploy(wallet, addresses[0], "LP AC", "LPAC", 18).send({ from: addresses[0] }).deployed();

        // Deploy AMM pools
        poolAB = await AMMContract.deploy(wallet, tokenA.address, tokenB.address, lpAB.address).send({ from: addresses[0] }).deployed();
        poolAC = await AMMContract.deploy(wallet, tokenA.address, tokenC.address, lpAC.address).send({ from: addresses[0] }).deployed();

        // Seed pools at correct initial ratio
        // Prices: A=$100, B=$200, C=$500
        // poolAB: rA*100 = rB*200 => rA/rB = 2 => 10000/5000
        // poolAC: rA*100 = rC*500 => rA/rC = 5 => 10000/2000
        await tokenA.methods.mint_to_public(poolAB.address, precision(10000n, DECIMALS)).send({ from: addresses[0] }).wait();
        await tokenB.methods.mint_to_public(poolAB.address, precision(5000n, DECIMALS)).send({ from: addresses[0] }).wait();
        await tokenA.methods.mint_to_public(poolAC.address, precision(10000n, DECIMALS)).send({ from: addresses[0] }).wait();
        await tokenC.methods.mint_to_public(poolAC.address, precision(2000n, DECIMALS)).send({ from: addresses[0] }).wait();

        // Set initial oracle prices
        await priceFeed.methods.set_price(tokenA.address.toField(), 100n).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(tokenB.address.toField(), 200n).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(tokenC.address.toField(), 500n).send({ from: addresses[0] }).wait();

        console.log("Setup complete");
    });

    test("rebalance pools after price change", { timeout: 300000 }, async () => {
        const minter = addresses[0];
        const swapper = addresses[1];

        const pools: PoolState[] = [
            {
                contract: poolAB,
                token0: tokenA,
                token1: tokenB,
                reserve0: precision(10000n, DECIMALS),
                reserve1: precision(5000n, DECIMALS),
            },
            {
                contract: poolAC,
                token0: tokenA,
                token1: tokenC,
                reserve0: precision(10000n, DECIMALS),
                reserve1: precision(2000n, DECIMALS),
            },
        ];

        // Verify initial pool ratios match initial prices
        // poolAB: rB/rA = 5000/10000 = 0.5 = priceA/priceB = 100/200 = 0.5
        // poolAC: rC/rA = 2000/10000 = 0.2 = priceA/priceC = 100/500 = 0.2
        console.log("\n=== Initial state ===");
        console.log(`  poolAB ratio (rB/rA): ${Number(pools[0].reserve1) / Number(pools[0].reserve0)}`);
        console.log(`  poolAC ratio (rC/rA): ${Number(pools[1].reserve1) / Number(pools[1].reserve0)}`);

        // Change prices drastically:
        // A: 100 -> 200 (doubles), B: 200 -> 100 (halves), C: 500 -> 250 (halves)
        // Target ratios after rebalance:
        // poolAB: rB/rA = priceA/priceB = 200/100 = 2.0 (need 4x more B)
        // poolAC: rC/rA = priceA/priceC = 200/250 = 0.8 (need more C)

        console.log("\n=== Rebalancing pools ===");
        await rebalancePools({
            priceFeed,
            minter,
            pools,
            tokenPrices: [
                { token: tokenA, price: 200n },
                { token: tokenB, price: 100n },
                { token: tokenC, price: 250n },
            ],
        });

        // Build price lookup for verification
        const priceMap = new Map<string, bigint>([
            [tokenA.address.toString(), 200n],
            [tokenB.address.toString(), 100n],
            [tokenC.address.toString(), 250n],
        ]);

        // Verify reserve ratios match new prices
        console.log("\n=== After rebalance ===");
        for (const pool of pools) {
            const addr0 = pool.token0.address.toString();
            const addr1 = pool.token1.address.toString();
            const p0 = priceMap.get(addr0)!;
            const p1 = priceMap.get(addr1)!;

            const value0 = pool.reserve0 * p0;
            const value1 = pool.reserve1 * p1;

            const ratio = Number(pool.reserve1) / Number(pool.reserve0);
            const targetRatio = Number(p0) / Number(p1);

            console.log(`  Pool ${addr0.slice(0, 10)}..:  r0=${pool.reserve0}, r1=${pool.reserve1}`);
            console.log(`    ratio (r1/r0): ${ratio.toFixed(6)}, target: ${targetRatio.toFixed(6)}`);
            console.log(`    value0: ${value0}, value1: ${value1}`);

            // Values should be approximately equal (within 1 token of the adjusted side)
            const diff = value0 > value1 ? value0 - value1 : value1 - value0;
            expect(diff).toBeLessThan(p1);
        }

        // Verify with a swap: 1 tokenA -> tokenB on poolAB
        // With prices A=200, B=100: 1 tokenA should get ~2 tokenB (minus 0.3% fee)
        const smallAmount = precision(1n, DECIMALS);
        await tokenA.methods.mint_to_private(swapper, smallAmount).send({ from: minter }).wait();

        const nonce = Fr.random();
        const authwit = await wallet.createAuthWit(swapper, {
            caller: poolAB.address,
            action: tokenA.methods.transfer_to_public(swapper, poolAB.address, smallAmount, nonce),
        });

        const amountOut = await poolAB.methods
            .get_amount_out_for_exact_in(pools[0].reserve0, pools[0].reserve1, smallAmount)
            .simulate({ from: swapper });

        // Expected ~2e9 * 0.997 = 1.994e9 (2:1 ratio minus 0.3% fee)
        const expectedApprox = precision(2n, DECIMALS) * 997n / 1000n;
        const tolerance = precision(1n, DECIMALS) / 10n; // 0.1 token

        console.log(`\n=== Swap verification ===`);
        console.log(`  Swap 1 tokenA -> tokenB`);
        console.log(`  Amount out: ${amountOut}`);
        console.log(`  Expected ~: ${expectedApprox}`);

        const outDiff = BigInt(amountOut) > expectedApprox
            ? BigInt(amountOut) - expectedApprox
            : expectedApprox - BigInt(amountOut);
        expect(outDiff).toBeLessThan(tolerance);
        console.log(`  Swap price check passed (within tolerance)`);

        // Execute the swap to confirm it works on-chain
        await poolAB.methods
            .swap_exact_tokens_for_tokens(tokenA.address, tokenB.address, smallAmount, amountOut, nonce)
            .with({ authWitnesses: [authwit] })
            .send({ from: swapper })
            .wait();
        console.log("  Swap executed successfully");

        console.log("\n  All assertions passed!");
    });

});
