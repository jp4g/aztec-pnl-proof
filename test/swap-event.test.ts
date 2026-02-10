import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '../src/artifacts/Token';
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

import individualSwapCircuit from '../circuits/individual_swap/target/individual_swap.json' with { type: 'json' };
import swapSummaryTreeCircuit from '../circuits/swap_summary_tree/target/swap_summary_tree.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Swap Event Proof Test (Buy + Sell with Multi-Token Lot Tree)", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token0: TokenContract;
    let token1: TokenContract;
    let liquidityToken: TokenContract;
    let amm: AMMContract;
    let priceFeed: PriceFeedContract;
    let bb: Barretenberg;

    // Initial AMM liquidity (use 9 decimals to avoid u128 overflow in AMM math)
    const DECIMALS = 9n;
    const TOKEN0_LIQUIDITY = precision(1000n, DECIMALS);
    const TOKEN1_LIQUIDITY = precision(2000n, DECIMALS);

    // Buy amount (token0 spent to acquire token1)
    const BUY_AMOUNT_IN = precision(10n, DECIMALS);

    // Oracle prices
    const TOKEN0_PRICE = 100n;
    const TOKEN1_BUY_PRICE = 200n;   // token1 price at buy time
    const TOKEN1_SELL_PRICE = 300n;   // token1 price at sell time (price went up)

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

        // Set initial prices for BOTH tokens
        console.log("Setting initial prices...");
        await priceFeed.methods.set_price(token0.address.toField(), TOKEN0_PRICE).send({ from: addresses[0] }).wait();
        await priceFeed.methods.set_price(token1.address.toField(), TOKEN1_BUY_PRICE).send({ from: addresses[0] }).wait();

        // Deploy liquidity token
        console.log("Deploying liquidity token...");
        liquidityToken = await TokenContract.deploy(
            wallet, addresses[0], "LP Token", "LP", 18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  liquidity token: ${liquidityToken.address}`);

        // Deploy our custom AMM (with swap event emission)
        console.log("Deploying AMM...");
        amm = await AMMContract.deploy(
            wallet, token0.address, token1.address, liquidityToken.address,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  AMM: ${amm.address}`);

        // Seed AMM with liquidity
        console.log("Seeding AMM with liquidity...");
        await token0.methods.mint_to_public(amm.address, TOKEN0_LIQUIDITY).send({ from: addresses[0] }).wait();
        await token1.methods.mint_to_public(amm.address, TOKEN1_LIQUIDITY).send({ from: addresses[0] }).wait();

        // Mint token0 for the buy swap
        console.log("Minting tokens to swapper...");
        await token0.methods.mint_to_private(addresses[1], BUY_AMOUNT_IN).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("buy then sell with multi-token lot tree PnL", { timeout: 600000 }, async () => {
        const swapper = addresses[1];
        const priceFeedAssetsSlot = PriceFeedContract.storage.assets.slot;

        // ========================================
        // STEP 1: Buy token1 (token0 -> token1) at price 200
        // ========================================
        console.log("\n=== STEP 1: Buy token1 ===");

        const nonce1 = Fr.random();
        const authwit1 = await wallet.createAuthWit(swapper, {
            caller: amm.address,
            action: token0.methods.transfer_to_public(swapper, amm.address, BUY_AMOUNT_IN, nonce1),
        });

        const amountOut1 = await amm.methods
            .get_amount_out_for_exact_in(TOKEN0_LIQUIDITY, TOKEN1_LIQUIDITY, BUY_AMOUNT_IN)
            .simulate({ from: swapper });
        console.log(`  Buy: spending ${BUY_AMOUNT_IN} token0, receiving ${amountOut1} token1`);

        await amm.methods
            .swap_exact_tokens_for_tokens(token0.address, token1.address, BUY_AMOUNT_IN, amountOut1, nonce1)
            .with({ authWitnesses: [authwit1] })
            .send({ from: swapper })
            .wait();
        console.log("  Buy executed!");

        // Reserves after buy
        const reserve0AfterBuy = TOKEN0_LIQUIDITY + BUY_AMOUNT_IN;
        const reserve1AfterBuy = TOKEN1_LIQUIDITY - BigInt(amountOut1);

        // ========================================
        // STEP 2: Update token1 price (200 -> 300)
        // ========================================
        console.log("\n=== STEP 2: Update oracle price ===");
        console.log(`  token1 price: ${TOKEN1_BUY_PRICE} -> ${TOKEN1_SELL_PRICE}`);
        await priceFeed.methods.set_price(token1.address.toField(), TOKEN1_SELL_PRICE).send({ from: addresses[0] }).wait();

        // ========================================
        // STEP 3: Sell ALL token1 back (token1 -> token0) at price 300
        // ========================================
        console.log("\n=== STEP 3: Sell token1 ===");

        const sellAmount = BigInt(amountOut1); // sell everything we bought

        const nonce2 = Fr.random();
        const authwit2 = await wallet.createAuthWit(swapper, {
            caller: amm.address,
            action: token1.methods.transfer_to_public(swapper, amm.address, sellAmount, nonce2),
        });

        const amountOut2 = await amm.methods
            .get_amount_out_for_exact_in(reserve1AfterBuy, reserve0AfterBuy, sellAmount)
            .simulate({ from: swapper });
        console.log(`  Sell: spending ${sellAmount} token1, receiving ${amountOut2} token0`);

        await amm.methods
            .swap_exact_tokens_for_tokens(token1.address, token0.address, sellAmount, amountOut2, nonce2)
            .with({ authWitnesses: [authwit2] })
            .send({ from: swapper })
            .wait();
        console.log("  Sell executed!");

        // ========================================
        // STEP 4: Discover swap events
        // ========================================
        console.log("\n=== STEP 4: Discover swap events ===");

        const taggingSecrets = await wallet.exportTaggingSecrets(swapper, [amm.address], [swapper]);
        console.log(`  Exported ${taggingSecrets.secrets.length} tagging secrets`);

        const events = await retrieveEncryptedEvents(node, taggingSecrets);
        console.log(`  Found ${events.totalEvents} events`);
        expect(events.totalEvents).toBeGreaterThanOrEqual(2);

        const allEvents = events.secrets.flatMap(s => s.events);
        console.log(`  Event 1 (buy):  ${allEvents[0].ciphertextBytes} bytes, block ${allEvents[0].blockNumber}`);
        console.log(`  Event 2 (sell): ${allEvents[1].ciphertextBytes} bytes, block ${allEvents[1].blockNumber}`);

        // ========================================
        // STEP 5: Generate individual swap proofs with multi-token lot tree
        // ========================================
        console.log("\n=== STEP 5: Generate individual swap proofs ===");

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

        const buyBlockNumber = BigInt(allEvents[0].blockNumber);
        const sellBlockNumber = BigInt(allEvents[1].blockNumber);

        // Initialize lot state tree with token0 lot from mint
        // (swapper starts with BUY_AMOUNT_IN of token0 at TOKEN0_PRICE)
        const lotStateTree = new LotStateTree();
        await lotStateTree.setLots(
            token0.address.toField(),
            [{ amount: BUY_AMOUNT_IN, costPerUnit: TOKEN0_PRICE }],
            1,
        );

        // Prove buy (token0 -> token1)
        // Sell-side = token0 (consumes the minted lot), Buy-side = token1 (creates new lot)
        const buyResult = await prover.prove(
            { encryptedLog: allEvents[0].ciphertextBuffer, blockNumber: buyBlockNumber },
            lotStateTree,
            priceFeed.address.toField(),
            priceFeedAssetsSlot,
        );

        console.log(`\n  Buy proof:`);
        console.log(`    leaf: ${buyResult.publicInputs.leaf}`);
        console.log(`    pnl: ${buyResult.publicInputs.pnl} (negative: ${buyResult.publicInputs.pnlIsNegative})`);

        // Buy consumes token0 lot. PnL on token0:
        // proceeds = BUY_AMOUNT_IN * TOKEN0_PRICE, cost = BUY_AMOUNT_IN * TOKEN0_PRICE => PnL = 0
        expect(buyResult.publicInputs.pnl).toBe(0n);
        expect(buyResult.publicInputs.pnlIsNegative).toBe(false);

        // Verify lot state tree: token0 lot consumed, token1 lot created
        const token1Lots = lotStateTree.getLots(token1.address.toField());
        expect(token1Lots.numLots).toBe(1);
        expect(token1Lots.lots[0].amount).toBe(BigInt(amountOut1));
        expect(token1Lots.lots[0].costPerUnit).toBe(TOKEN1_BUY_PRICE);

        const token0LotsAfterBuy = lotStateTree.getLots(token0.address.toField());
        expect(token0LotsAfterBuy.numLots).toBe(0);

        // Prove sell (token1 -> token0)
        // Sell-side = token1 (consumes the lot), Buy-side = token0 (creates new lot)
        const sellResult = await prover.prove(
            { encryptedLog: allEvents[1].ciphertextBuffer, blockNumber: sellBlockNumber },
            lotStateTree,
            priceFeed.address.toField(),
            priceFeedAssetsSlot,
            buyBlockNumber, // previous block number
        );

        console.log(`\n  Sell proof:`);
        console.log(`    leaf: ${sellResult.publicInputs.leaf}`);
        console.log(`    pnl: ${sellResult.publicInputs.pnl} (negative: ${sellResult.publicInputs.pnlIsNegative})`);

        // Sell consumes token1 lot. PnL on token1:
        // proceeds = amountOut1 * SELL_PRICE, cost = amountOut1 * BUY_PRICE
        // PnL = amountOut1 * (300 - 200) = amountOut1 * 100
        const expectedPnl = BigInt(amountOut1) * (TOKEN1_SELL_PRICE - TOKEN1_BUY_PRICE);
        console.log(`\n  Expected PnL: ${expectedPnl}`);
        console.log(`  Actual PnL:   ${sellResult.publicInputs.pnl}`);

        expect(sellResult.publicInputs.pnl).toBe(expectedPnl);
        expect(sellResult.publicInputs.pnlIsNegative).toBe(false); // gain, not loss

        // Verify lot state tree: token1 lots consumed, token0 lot created
        const token1LotsAfterSell = lotStateTree.getLots(token1.address.toField());
        expect(token1LotsAfterSell.numLots).toBe(0);

        const token0LotsAfterSell = lotStateTree.getLots(token0.address.toField());
        expect(token0LotsAfterSell.numLots).toBe(1);
        expect(token0LotsAfterSell.lots[0].amount).toBe(BigInt(amountOut2));

        // Lot state root chain: buy's remaining = sell's initial
        expect(buyResult.publicInputs.remainingLotStateRoot).toBe(sellResult.publicInputs.initialLotStateRoot);

        // Verify swap data
        expect(buyResult.swapData.tokenIn).toBe(token0.address.toField().toString());
        expect(buyResult.swapData.tokenOut).toBe(token1.address.toField().toString());
        expect(buyResult.swapData.amountIn).toBe(BigInt(BUY_AMOUNT_IN));
        expect(buyResult.swapData.amountOut).toBe(BigInt(amountOut1));

        expect(sellResult.swapData.tokenIn).toBe(token1.address.toField().toString());
        expect(sellResult.swapData.tokenOut).toBe(token0.address.toField().toString());
        expect(sellResult.swapData.amountIn).toBe(sellAmount);
        expect(sellResult.swapData.amountOut).toBe(BigInt(amountOut2));

        // Verify leaf hashes
        const expectedBuyLeaf = await poseidon2Hash([
            new Fr(buyBlockNumber),
            token0.address.toField(),
            token1.address.toField(),
            new Fr(BUY_AMOUNT_IN),
            new Fr(amountOut1),
            new Fr(1n),
        ]);
        expect(buyResult.publicInputs.leaf).toBe(expectedBuyLeaf.toString());

        const expectedSellLeaf = await poseidon2Hash([
            new Fr(sellBlockNumber),
            token1.address.toField(),
            token0.address.toField(),
            new Fr(sellAmount),
            new Fr(amountOut2),
            new Fr(1n),
        ]);
        expect(sellResult.publicInputs.leaf).toBe(expectedSellLeaf.toString());

        console.log("\n  Individual proof assertions passed!");

        // ========================================
        // STEP 6: Aggregate proofs with SwapProofTree
        // ========================================
        console.log("\n=== STEP 6: Aggregate swap proofs ===");

        const proofTree = new SwapProofTree({
            bb,
            leafCircuit: individualSwapCircuit as CompiledCircuit,
            summaryCircuit: swapSummaryTreeCircuit as CompiledCircuit,
            swapProver: prover,
        });

        // Fresh lot state tree for aggregation (same initial state)
        const aggLotStateTree = new LotStateTree();
        await aggLotStateTree.setLots(
            token0.address.toField(),
            [{ amount: BUY_AMOUNT_IN, costPerUnit: TOKEN0_PRICE }],
            1,
        );

        const aggregateResult = await proofTree.prove(
            [
                { encryptedLog: allEvents[0].ciphertextBuffer, blockNumber: buyBlockNumber },
                { encryptedLog: allEvents[1].ciphertextBuffer, blockNumber: sellBlockNumber },
            ],
            aggLotStateTree,
            priceFeed.address.toField(),
            priceFeedAssetsSlot,
        );

        console.log(`\n=== AGGREGATE PROOF RESULT ===`);
        console.log(`  root: ${aggregateResult.publicInputs.root}`);
        console.log(`  pnl: ${aggregateResult.publicInputs.pnl} (negative: ${aggregateResult.publicInputs.pnlIsNegative})`);
        console.log(`  signedPnl: ${aggregateResult.signedPnl}`);
        console.log(`  Proof size: ${aggregateResult.proof.length} bytes`);

        // Total PnL should match: buy PnL (0) + sell PnL (amountOut1 * 100)
        expect(aggregateResult.signedPnl).toBe(BigInt(expectedPnl));
        expect(aggregateResult.publicInputs.pnl).toBe(expectedPnl);
        expect(aggregateResult.publicInputs.pnlIsNegative).toBe(false);

        // Verify merkle root = poseidon2Hash([buyLeaf, sellLeaf])
        const expectedRoot = await poseidon2Hash([expectedBuyLeaf, expectedSellLeaf]);
        expect(aggregateResult.publicInputs.root).toBe(expectedRoot.toString());

        // Verify block number
        expect(aggregateResult.publicInputs.blockNumber).toBe(sellBlockNumber);

        console.log(`\n  Expected root: ${expectedRoot.toString()}`);
        console.log(`  Actual root:   ${aggregateResult.publicInputs.root}`);
        console.log(`  Expected PnL:  ${expectedPnl}`);
        console.log(`  Actual PnL:    ${aggregateResult.signedPnl}`);
        console.log("\n  All assertions passed!");
    });

});
