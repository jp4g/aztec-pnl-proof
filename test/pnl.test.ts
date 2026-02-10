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

import individualSwapCircuit from '../circuits/individual_swap/target/individual_swap.json' with { type: 'json' };
import swapSummaryTreeCircuit from '../circuits/swap_summary_tree/target/swap_summary_tree.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("PnL Proof Test (5 swaps, varying prices)", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token0: TokenContract;
    let token1: TokenContract;
    let liquidityToken: TokenContract;
    let amm: AMMContract;
    let priceFeed: PriceFeedContract;
    let bb: Barretenberg;

    const DECIMALS = 9n;
    const TOKEN0_LIQUIDITY = precision(10000n, DECIMALS);
    const TOKEN1_LIQUIDITY = precision(20000n, DECIMALS);

    // 5 swap amounts (all token0 -> token1, i.e. all buys of token1)
    const SWAP_AMOUNTS = [
        precision(10n, DECIMALS),
        precision(8n, DECIMALS),
        precision(12n, DECIMALS),
        precision(6n, DECIMALS),
        precision(15n, DECIMALS),
    ];
    const TOTAL_SWAP_IN = SWAP_AMOUNTS.reduce((a, b) => a + b, 0n);

    // Prices change before each swap (token0_price, token1_price)
    // With 4-decimal precision convention: 100 = $0.01, 10000 = $1.00
    const PRICE_SCHEDULE: [bigint, bigint][] = [
        [100n, 200n],  // Swap 1: token0=$1.00, token1=$2.00
        [120n, 180n],  // Swap 2: token0 up, token1 down
        [80n, 250n],   // Swap 3: token0 crashes, token1 moons
        [150n, 160n],  // Swap 4: token0 recovers, token1 drops
        [90n, 220n],   // Swap 5: token0 drops again, token1 rises
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

        // Deploy token0
        console.log("Deploying token0...");
        token0 = await TokenContract.deploy(
            wallet, addresses[0], "Token Zero", "TK0", 18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token0: ${token0.address}`);

        // Deploy token1
        console.log("Deploying token1...");
        token1 = await TokenContract.deploy(
            wallet, addresses[0], "Token One", "TK1", 18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token1: ${token1.address}`);

        // Set initial prices
        console.log("Setting initial prices...");
        await priceFeed.methods.set_price(token0.address.toField(), PRICE_SCHEDULE[0][0]).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(token1.address.toField(), PRICE_SCHEDULE[0][1]).send({ from: addresses[0] }).wait();
        console.log(`  token0 price: ${PRICE_SCHEDULE[0][0]}, token1 price: ${PRICE_SCHEDULE[0][1]}`);

        // Deploy liquidity token
        console.log("Deploying liquidity token...");
        liquidityToken = await TokenContract.deploy(
            wallet, addresses[0], "LP Token", "LP", 18,
        ).send({ from: addresses[0] }).deployed();

        // Deploy AMM
        console.log("Deploying AMM...");
        amm = await AMMContract.deploy(
            wallet, token0.address, token1.address, liquidityToken.address,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  AMM: ${amm.address}`);

        // Seed AMM with liquidity
        console.log("Seeding AMM with liquidity...");
        await token0.methods.mint_to_public(amm.address, TOKEN0_LIQUIDITY).send({ from: addresses[0] }).wait();
        await token1.methods.mint_to_public(amm.address, TOKEN1_LIQUIDITY).send({ from: addresses[0] }).wait();

        // Mint enough token0 for all 5 swaps
        console.log(`Minting ${TOTAL_SWAP_IN} token0 to swapper...`);
        await token0.methods.mint_to_private(addresses[1], TOTAL_SWAP_IN).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("prove PnL from 5 swaps with varying prices", { timeout: 900000 }, async () => {
        const swapper = addresses[1];

        // We track token1 — all 5 swaps are token0→token1, so all are "buys" of token1.
        // PnL will be 0 (no sells to realize gains). This test validates lot accumulation
        // across 5 swaps with varying oracle prices, and the full aggregation pipeline.
        const trackedToken = token1.address.toField();

        // Track reserves for computing expected outputs
        let reserve0 = TOKEN0_LIQUIDITY;
        let reserve1 = TOKEN1_LIQUIDITY;
        const amountsOut: bigint[] = [];

        // ========================================
        // Execute 5 swaps, updating prices before each
        // ========================================
        for (let i = 0; i < 5; i++) {
            console.log(`\n=== SWAP ${i + 1}/5 ===`);

            // Update prices before each swap (skip first since already set in setup)
            if (i > 0) {
                const [p0, p1] = PRICE_SCHEDULE[i];
                console.log(`  Updating prices: token0=${p0}, token1=${p1}`);
                await priceFeed.methods.set_price(token0.address.toField(), p0).send({ from: addresses[0] }).wait();
                await priceFeed.methods.set_price(token1.address.toField(), p1).send({ from: addresses[0] }).wait();
            }

            const amountIn = SWAP_AMOUNTS[i];
            const nonce = Fr.random();
            const authwit = await wallet.createAuthWit(swapper, {
                caller: amm.address,
                action: token0.methods.transfer_to_public(swapper, amm.address, amountIn, nonce),
            });

            const amountOut = await amm.methods
                .get_amount_out_for_exact_in(reserve0, reserve1, amountIn)
                .simulate({ from: swapper });
            console.log(`  Amount in: ${amountIn}, Expected out: ${amountOut}`);

            await amm.methods
                .swap_exact_tokens_for_tokens(token0.address, token1.address, amountIn, amountOut, nonce)
                .with({ authWitnesses: [authwit] })
                .send({ from: swapper })
                .wait();
            console.log(`  Swap ${i + 1} executed!`);

            amountsOut.push(BigInt(amountOut));
            reserve0 += amountIn;
            reserve1 -= BigInt(amountOut);
        }

        // ========================================
        // Discover swap events
        // ========================================
        console.log("\n=== Discover swap events ===");

        const taggingSecrets = await wallet.exportTaggingSecrets(swapper, [amm.address], [swapper]);
        const events = await retrieveEncryptedEvents(node, taggingSecrets);
        console.log(`  Found ${events.totalEvents} events`);
        expect(events.totalEvents).toBeGreaterThanOrEqual(5);

        const allEvents = events.secrets.flatMap(s => s.events);
        const blockNumbers = allEvents.slice(0, 5).map(e => BigInt(e.blockNumber));
        console.log(`  Block numbers: ${blockNumbers.join(', ')}`);

        // ========================================
        // Aggregate swap proofs with FIFO PnL
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
        const result = await proofTree.prove(
            allEvents.slice(0, 5).map((e, i) => ({
                encryptedLog: e.ciphertextBuffer,
                blockNumber: blockNumbers[i],
            })),
            trackedToken,
            priceFeed.address.toField(),
            priceFeedAssetsSlot,
        );

        console.log(`\n=== FINAL PROOF RESULT ===`);
        console.log(`  root: ${result.publicInputs.root}`);
        console.log(`  pnl: ${result.publicInputs.pnl} (negative: ${result.publicInputs.pnlIsNegative})`);
        console.log(`  signedPnl: ${result.signedPnl}`);
        console.log(`  remainingLotsHash: ${result.publicInputs.remainingLotsHash}`);
        console.log(`  initialLotsHash: ${result.publicInputs.initialLotsHash}`);
        console.log(`  price_feed_address: ${result.publicInputs.priceFeedAddress}`);

        // ========================================
        // Verify results
        // ========================================
        console.log("\n=== Verify results ===");

        // All swaps are buys of token1, so PnL = 0 (no sells to realize gains)
        expect(result.signedPnl).toBe(0n);
        expect(result.publicInputs.pnl).toBe(0n);
        expect(result.publicInputs.pnlIsNegative).toBe(false);

        // 5 buys -> 5 lots
        expect(result.remainingNumLots).toBe(5);

        // Each lot should have the amount out from the swap and the oracle price at that block
        for (let i = 0; i < 5; i++) {
            expect(result.remainingLots[i].amount).toBe(amountsOut[i]);
            expect(result.remainingLots[i].costPerUnit).toBe(PRICE_SCHEDULE[i][1]);
            console.log(`  Lot ${i}: amount=${result.remainingLots[i].amount}, costPerUnit=${result.remainingLots[i].costPerUnit}`);
        }

        // Verify price feed address
        expect(result.publicInputs.priceFeedAddress).toBe(priceFeed.address.toField().toString());

        // Verify merkle root matches TS-computed
        const expectedLeaves: Fr[] = [];
        for (let i = 0; i < 5; i++) {
            expectedLeaves.push(await poseidon2Hash([
                new Fr(blockNumbers[i]),
                token0.address.toField(),
                token1.address.toField(),
                new Fr(SWAP_AMOUNTS[i]),
                new Fr(amountsOut[i]),
                new Fr(1n),
            ]));
        }
        // The swap_summary_tree builds a binary tree with zero hashes for padding
        // 5 leaves: [l0,l1], [l2,l3], [l4,zero_0] -> [h01,h23], [h4z,zero_1] -> [hA, hB] -> root
        const zero0 = Fr.ZERO;
        const zero1 = await poseidon2Hash([zero0, zero0]);
        const h01 = await poseidon2Hash([expectedLeaves[0], expectedLeaves[1]]);
        const h23 = await poseidon2Hash([expectedLeaves[2], expectedLeaves[3]]);
        const h4z = await poseidon2Hash([expectedLeaves[4], zero0]);
        const hA = await poseidon2Hash([h01, h23]);
        const hB = await poseidon2Hash([h4z, zero1]);
        const expectedRoot = await poseidon2Hash([hA, hB]);

        expect(result.publicInputs.root).toBe(expectedRoot.toString());
        console.log(`  Merkle root matches!`);

        console.log("\n  All assertions passed!");
    });

});
