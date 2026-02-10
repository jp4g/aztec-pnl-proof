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
import { Barretenberg } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { retrieveEncryptedEvents } from '../src/event-reader';
import { SwapProver } from '../src/swap-prover';
import { SwapProofTree } from '../src/swap-proof-tree';
import { LotStateTree } from '../src/lot-state-tree';
import { rebalancePools, type PoolState } from '../src/rebalance';

import individualSwapCircuit from '../circuits/individual_swap/target/individual_swap.json' with { type: 'json' };
import swapSummaryTreeCircuit from '../circuits/swap_summary_tree/target/swap_summary_tree.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("PnL Proof Test (3 pools, 6 swaps, multi-token lot tree)", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];

    // 3 tokens
    let tokenA: TokenContract;
    let tokenB: TokenContract;
    let tokenC: TokenContract;

    // 3 AMM pools: AB (A/B), AC (A/C), BC (B/C)
    let poolAB: AMMContract;
    let poolAC: AMMContract;
    let poolBC: AMMContract;

    // LP tokens (one per pool)
    let lpAB: TokenContract;
    let lpAC: TokenContract;
    let lpBC: TokenContract;

    let priceFeed: PriceFeedContract;
    let bb: Barretenberg;

    const DECIMALS = 9n;

    // Pool liquidity
    const POOL_AB_LIQ_A = precision(10000n, DECIMALS);
    const POOL_AB_LIQ_B = precision(5000n, DECIMALS);
    const POOL_AC_LIQ_A = precision(10000n, DECIMALS);
    const POOL_AC_LIQ_C = precision(2000n, DECIMALS);
    const POOL_BC_LIQ_B = precision(5000n, DECIMALS);
    const POOL_BC_LIQ_C = precision(2000n, DECIMALS);

    // Swapper starts with 50 tokenA (private)
    const INITIAL_TOKEN_A = precision(50n, DECIMALS);

    // Oracle prices per swap: [tokenA, tokenB, tokenC]
    // Swap 1-2 share baseline prices, then prices shift before each subsequent swap
    const PRICE_SCHEDULE: [bigint, bigint, bigint][] = [
        [100n, 200n, 500n],   // Swap 1: baseline
        [100n, 200n, 500n],   // Swap 2: same prices
        [130n, 170n, 600n],   // Swap 3: A up, B down, C up
        [90n, 250n, 400n],    // Swap 4: A crashes, B moons, C drops
        [110n, 220n, 550n],   // Swap 5: moderate recovery
        [95n, 280n, 450n],    // Swap 6: A down, B up more, C down
    ];

    // Swap amounts (token_in amounts)
    const SWAP_AMOUNTS = [
        precision(15n, DECIMALS),  // Swap 1: 15 A -> B on poolAB
        precision(10n, DECIMALS),  // Swap 2: 10 A -> C on poolAC
        precision(5n, DECIMALS),   // Swap 3:  5 B -> C on poolBC
        precision(3n, DECIMALS),   // Swap 4:  3 C -> A on poolAC
        precision(12n, DECIMALS),  // Swap 5: 12 A -> B on poolAB
        precision(4n, DECIMALS),   // Swap 6:  4 B -> A on poolAB
    ];

    // Swap directions: tokenIn -> tokenOut on pool
    type TokenKey = 'A' | 'B' | 'C';
    type PoolKey = 'AB' | 'AC' | 'BC';
    const SWAP_DIRS: { inKey: TokenKey; outKey: TokenKey; pool: PoolKey }[] = [
        { inKey: 'A', outKey: 'B', pool: 'AB' },  // Swap 1
        { inKey: 'A', outKey: 'C', pool: 'AC' },  // Swap 2
        { inKey: 'B', outKey: 'C', pool: 'BC' },  // Swap 3
        { inKey: 'C', outKey: 'A', pool: 'AC' },  // Swap 4
        { inKey: 'A', outKey: 'B', pool: 'AB' },  // Swap 5
        { inKey: 'B', outKey: 'A', pool: 'AB' },  // Swap 6
    ];

    before(async () => {
        console.log("Initializing Barretenberg...");
        const threads = require('os').cpus().length;
        bb = await Barretenberg.new({ threads });
        console.log("Barretenberg initialized");

        node = createAztecNodeClient(AZTEC_NODE_URL);
        console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false });

        const accounts = await getInitialTestAccountsData();
        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }

        // Deploy PriceFeed
        console.log("Deploying PriceFeed...");
        priceFeed = await PriceFeedContract.deploy(wallet).send({ from: addresses[0] }).deployed();
        console.log(`  PriceFeed: ${priceFeed.address}`);

        // Deploy 3 tokens
        console.log("Deploying tokens...");
        tokenA = await TokenContract.deploy(wallet, addresses[0], "Token A", "TKA", 18).send({ from: addresses[0] }).deployed();
        tokenB = await TokenContract.deploy(wallet, addresses[0], "Token B", "TKB", 18).send({ from: addresses[0] }).deployed();
        tokenC = await TokenContract.deploy(wallet, addresses[0], "Token C", "TKC", 18).send({ from: addresses[0] }).deployed();
        console.log(`  tokenA: ${tokenA.address}`);
        console.log(`  tokenB: ${tokenB.address}`);
        console.log(`  tokenC: ${tokenC.address}`);

        // Set initial oracle prices
        console.log("Setting initial prices...");
        await priceFeed.methods.set_price(tokenA.address.toField(), PRICE_SCHEDULE[0][0]).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(tokenB.address.toField(), PRICE_SCHEDULE[0][1]).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(tokenC.address.toField(), PRICE_SCHEDULE[0][2]).send({ from: addresses[0] }).wait();
        console.log(`  A=${PRICE_SCHEDULE[0][0]}, B=${PRICE_SCHEDULE[0][1]}, C=${PRICE_SCHEDULE[0][2]}`);

        // Deploy 3 LP tokens
        console.log("Deploying LP tokens...");
        lpAB = await TokenContract.deploy(wallet, addresses[0], "LP AB", "LPAB", 18).send({ from: addresses[0] }).deployed();
        lpAC = await TokenContract.deploy(wallet, addresses[0], "LP AC", "LPAC", 18).send({ from: addresses[0] }).deployed();
        lpBC = await TokenContract.deploy(wallet, addresses[0], "LP BC", "LPBC", 18).send({ from: addresses[0] }).deployed();

        // Deploy 3 AMM pools
        console.log("Deploying AMM pools...");
        poolAB = await AMMContract.deploy(wallet, tokenA.address, tokenB.address, lpAB.address).send({ from: addresses[0] }).deployed();
        poolAC = await AMMContract.deploy(wallet, tokenA.address, tokenC.address, lpAC.address).send({ from: addresses[0] }).deployed();
        poolBC = await AMMContract.deploy(wallet, tokenB.address, tokenC.address, lpBC.address).send({ from: addresses[0] }).deployed();
        console.log(`  poolAB: ${poolAB.address}`);
        console.log(`  poolAC: ${poolAC.address}`);
        console.log(`  poolBC: ${poolBC.address}`);

        // Seed pools with liquidity
        console.log("Seeding pools with liquidity...");
        await tokenA.methods.mint_to_public(poolAB.address, POOL_AB_LIQ_A).send({ from: addresses[0] }).wait();
        await tokenB.methods.mint_to_public(poolAB.address, POOL_AB_LIQ_B).send({ from: addresses[0] }).wait();
        await tokenA.methods.mint_to_public(poolAC.address, POOL_AC_LIQ_A).send({ from: addresses[0] }).wait();
        await tokenC.methods.mint_to_public(poolAC.address, POOL_AC_LIQ_C).send({ from: addresses[0] }).wait();
        await tokenB.methods.mint_to_public(poolBC.address, POOL_BC_LIQ_B).send({ from: addresses[0] }).wait();
        await tokenC.methods.mint_to_public(poolBC.address, POOL_BC_LIQ_C).send({ from: addresses[0] }).wait();

        // Mint tokenA to swapper (private)
        console.log(`Minting ${INITIAL_TOKEN_A} tokenA to swapper...`);
        await tokenA.methods.mint_to_private(addresses[1], INITIAL_TOKEN_A).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("prove PnL from 6 swaps across 3 pools with varying prices", { timeout: 1200000 }, async () => {
        const swapper = addresses[1];
        const minter = addresses[0];

        const tokenMap: Record<TokenKey, TokenContract> = { A: tokenA, B: tokenB, C: tokenC };
        const poolMap: Record<PoolKey, AMMContract> = { AB: poolAB, AC: poolAC, BC: poolBC };

        // Track pool state (reserves mutated by rebalancer + swaps)
        const poolStates: Record<PoolKey, PoolState> = {
            AB: { contract: poolAB, token0: tokenA, token1: tokenB, reserve0: POOL_AB_LIQ_A, reserve1: POOL_AB_LIQ_B },
            AC: { contract: poolAC, token0: tokenA, token1: tokenC, reserve0: POOL_AC_LIQ_A, reserve1: POOL_AC_LIQ_C },
            BC: { contract: poolBC, token0: tokenB, token1: tokenC, reserve0: POOL_BC_LIQ_B, reserve1: POOL_BC_LIQ_C },
        };
        const allPools = [poolStates.AB, poolStates.AC, poolStates.BC];

        const amountsOut: bigint[] = [];

        // ========================================
        // Execute 6 swaps across 3 pools
        // ========================================
        for (let i = 0; i < 6; i++) {
            console.log(`\n=== SWAP ${i + 1}/6 ===`);

            const dir = SWAP_DIRS[i];
            const tokenIn = tokenMap[dir.inKey];
            const tokenOut = tokenMap[dir.outKey];
            const pool = poolMap[dir.pool];
            const ps = poolStates[dir.pool];
            const amountIn = SWAP_AMOUNTS[i];

            // Rebalance pools when prices change
            if (i > 0) {
                const [pA, pB, pC] = PRICE_SCHEDULE[i];
                const [prevA, prevB, prevC] = PRICE_SCHEDULE[i - 1];
                if (pA !== prevA || pB !== prevB || pC !== prevC) {
                    console.log(`  Rebalancing to prices: A=${pA}, B=${pB}, C=${pC}`);
                    await rebalancePools({
                        priceFeed,
                        minter,
                        pools: allPools,
                        tokenPrices: [
                            { token: tokenA, price: pA },
                            { token: tokenB, price: pB },
                            { token: tokenC, price: pC },
                        ],
                    });
                }
            }

            // Determine reserve ordering for AMM call
            const sellingToken0 = tokenIn.address.equals(ps.token0.address);
            const reserveIn = sellingToken0 ? ps.reserve0 : ps.reserve1;
            const reserveOut = sellingToken0 ? ps.reserve1 : ps.reserve0;

            const nonce = Fr.random();
            const authwit = await wallet.createAuthWit(swapper, {
                caller: pool.address,
                action: tokenIn.methods.transfer_to_public(swapper, pool.address, amountIn, nonce),
            });

            const amountOut = await pool.methods
                .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
                .simulate({ from: swapper });
            console.log(`  ${dir.inKey} -> ${dir.outKey} on pool${dir.pool}: in=${amountIn}, out=${amountOut}`);

            await pool.methods
                .swap_exact_tokens_for_tokens(tokenIn.address, tokenOut.address, amountIn, amountOut, nonce)
                .with({ authWitnesses: [authwit] })
                .send({ from: swapper })
                .wait();
            console.log(`  Swap ${i + 1} executed!`);

            amountsOut.push(BigInt(amountOut));

            // Update tracked reserves
            if (sellingToken0) {
                ps.reserve0 += amountIn;
                ps.reserve1 -= BigInt(amountOut);
            } else {
                ps.reserve1 += amountIn;
                ps.reserve0 -= BigInt(amountOut);
            }
        }

        // ========================================
        // Discover swap events from all 3 pools
        // ========================================
        console.log("\n=== Discover swap events ===");

        const taggingSecrets = await wallet.exportTaggingSecrets(
            swapper,
            [poolAB.address, poolAC.address, poolBC.address],
            [swapper],
        );
        const events = await retrieveEncryptedEvents(node, taggingSecrets);
        console.log(`  Found ${events.totalEvents} events`);
        expect(events.totalEvents).toBeGreaterThanOrEqual(6);

        // Collect all events and sort chronologically
        const allEvents = events.secrets
            .flatMap(s => s.events)
            .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
        const swapEvents = allEvents.slice(0, 6);
        const blockNumbers = swapEvents.map(e => BigInt(e.blockNumber));
        console.log(`  Block numbers: ${blockNumbers.join(', ')}`);

        // ========================================
        // Compute expected PnL via FIFO lot tracking
        // ========================================
        console.log("\n=== Compute expected PnL ===");

        const priceIdx: Record<TokenKey, number> = { A: 0, B: 1, C: 2 };
        const lotTracker: Record<TokenKey, { amount: bigint; costPerUnit: bigint }[]> = {
            A: [{ amount: INITIAL_TOKEN_A, costPerUnit: PRICE_SCHEDULE[0][0] }],
            B: [],
            C: [],
        };

        let expectedPnl = 0n;

        for (let i = 0; i < 6; i++) {
            const dir = SWAP_DIRS[i];
            const sellPrice = PRICE_SCHEDULE[i][priceIdx[dir.inKey]];
            const buyPrice = PRICE_SCHEDULE[i][priceIdx[dir.outKey]];
            const amountIn = SWAP_AMOUNTS[i];
            const amountOut = amountsOut[i];

            // FIFO consume lots of tokenIn
            let remaining = amountIn;
            const sellLots = lotTracker[dir.inKey];
            for (const lot of sellLots) {
                if (remaining <= 0n) break;
                const consumed = remaining < lot.amount ? remaining : lot.amount;
                expectedPnl += consumed * (sellPrice - lot.costPerUnit);
                lot.amount -= consumed;
                remaining -= consumed;
            }
            lotTracker[dir.inKey] = sellLots.filter(l => l.amount > 0n);

            // Add buy lot for tokenOut
            lotTracker[dir.outKey].push({ amount: amountOut, costPerUnit: buyPrice });

            console.log(`  Swap ${i + 1}: sell ${dir.inKey}@${sellPrice}, buy ${dir.outKey}@${buyPrice}, PnL so far: ${expectedPnl}`);
        }

        console.log(`  Expected total PnL: ${expectedPnl}`);

        // ========================================
        // Generate and aggregate swap proofs
        // ========================================
        console.log("\n=== Generate and aggregate swap proofs ===");

        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(swapper)
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(swapper);

        const prover = new SwapProver({
            bb,
            circuit: individualSwapCircuit as CompiledCircuit,
            recipientCompleteAddress,
            ivskM,
            node,
        });

        const proofTree = new SwapProofTree({
            bb,
            leafCircuit: individualSwapCircuit as CompiledCircuit,
            summaryCircuit: swapSummaryTreeCircuit as CompiledCircuit,
            swapProver: prover,
        });

        const priceFeedAssetsSlot = PriceFeedContract.storage.assets.slot;

        // Initialize lot state tree with tokenA lot from mint
        const lotStateTree = new LotStateTree();
        await lotStateTree.setLots(
            tokenA.address.toField(),
            [{ amount: INITIAL_TOKEN_A, costPerUnit: PRICE_SCHEDULE[0][0] }],
            1,
        );

        const result = await proofTree.prove(
            swapEvents.map((e, i) => ({
                encryptedLog: e.ciphertextBuffer,
                blockNumber: blockNumbers[i],
            })),
            lotStateTree,
            priceFeed.address.toField(),
            priceFeedAssetsSlot,
        );

        console.log(`\n=== FINAL PROOF RESULT ===`);
        console.log(`  root: ${result.publicInputs.root}`);
        console.log(`  pnl: ${result.publicInputs.pnl} (negative: ${result.publicInputs.pnlIsNegative})`);
        console.log(`  signedPnl: ${result.signedPnl}`);
        console.log(`  remainingLotStateRoot: ${result.publicInputs.remainingLotStateRoot}`);
        console.log(`  initialLotStateRoot: ${result.publicInputs.initialLotStateRoot}`);
        console.log(`  price_feed_address: ${result.publicInputs.priceFeedAddress}`);
        console.log(`  block_number: ${result.publicInputs.blockNumber}`);

        // ========================================
        // Verify results
        // ========================================
        console.log("\n=== Verify results ===");

        console.log(`  Expected total PnL: ${expectedPnl}`);
        console.log(`  Actual total PnL:   ${result.signedPnl}`);
        expect(result.signedPnl).toBe(expectedPnl);

        // Verify remaining lots match our FIFO tracker
        for (const key of ['A', 'B', 'C'] as const) {
            const token = tokenMap[key];
            const expected = lotTracker[key];
            const actual = lotStateTree.getLots(token.address.toField());
            expect(actual.numLots).toBe(expected.length);
            for (let j = 0; j < expected.length; j++) {
                expect(actual.lots[j].amount).toBe(expected[j].amount);
                expect(actual.lots[j].costPerUnit).toBe(expected[j].costPerUnit);
                console.log(`  ${key} Lot ${j}: amount=${actual.lots[j].amount}, cost=${actual.lots[j].costPerUnit}`);
            }
            if (expected.length === 0) {
                console.log(`  ${key}: all lots consumed`);
            }
        }

        // Verify price feed address
        expect(result.publicInputs.priceFeedAddress).toBe(priceFeed.address.toField().toString());

        // Verify block number is the last swap's block
        expect(result.publicInputs.blockNumber).toBe(blockNumbers[5]);

        // Verify merkle root
        const expectedLeaves: Fr[] = [];
        for (let i = 0; i < 6; i++) {
            const dir = SWAP_DIRS[i];
            expectedLeaves.push(await poseidon2Hash([
                new Fr(blockNumbers[i]),
                tokenMap[dir.inKey].address.toField(),
                tokenMap[dir.outKey].address.toField(),
                new Fr(SWAP_AMOUNTS[i]),
                new Fr(amountsOut[i]),
                new Fr(1n),
            ]));
        }

        // 6 leaves -> binary tree:
        // Level 0: [l0,l1], [l2,l3], [l4,l5]
        // Level 1: [h01,h23], [h45,zero_1]
        // Level 2: root
        const zero0 = Fr.ZERO;
        const zero1 = await poseidon2Hash([zero0, zero0]);
        const h01 = await poseidon2Hash([expectedLeaves[0], expectedLeaves[1]]);
        const h23 = await poseidon2Hash([expectedLeaves[2], expectedLeaves[3]]);
        const h45 = await poseidon2Hash([expectedLeaves[4], expectedLeaves[5]]);
        const hA = await poseidon2Hash([h01, h23]);
        const hB = await poseidon2Hash([h45, zero1]);
        const expectedRoot = await poseidon2Hash([hA, hB]);

        expect(result.publicInputs.root).toBe(expectedRoot.toString());
        console.log(`  Merkle root matches!`);

        console.log("\n  All assertions passed!");
    });

});
