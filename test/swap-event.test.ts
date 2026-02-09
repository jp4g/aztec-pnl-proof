import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '@aztec/noir-contracts.js/Token';
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

describe("Swap Event Proof Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token0: TokenContract;
    let token1: TokenContract;
    let liquidityToken: TokenContract;
    let amm: AMMContract;
    let bb: Barretenberg;

    // Initial AMM liquidity (use 9 decimals to avoid u128 overflow in AMM math)
    const DECIMALS = 9n;
    const TOKEN0_LIQUIDITY = precision(1000n, DECIMALS);
    const TOKEN1_LIQUIDITY = precision(2000n, DECIMALS);

    // Swap amounts
    const SWAP1_AMOUNT_IN = precision(10n, DECIMALS);
    const SWAP2_AMOUNT_IN = precision(5n, DECIMALS);

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

        // Deploy token0
        console.log("Deploying token0...");
        token0 = await TokenContract.deploy(
            wallet,
            addresses[0],
            "Token Zero",
            "TK0",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token0: ${token0.address}`);

        // Deploy token1
        console.log("Deploying token1...");
        token1 = await TokenContract.deploy(
            wallet,
            addresses[0],
            "Token One",
            "TK1",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token1: ${token1.address}`);

        // Deploy liquidity token
        console.log("Deploying liquidity token...");
        liquidityToken = await TokenContract.deploy(
            wallet,
            addresses[0],
            "LP Token",
            "LP",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  liquidity token: ${liquidityToken.address}`);

        // Deploy our custom AMM (with swap event emission)
        console.log("Deploying AMM...");
        amm = await AMMContract.deploy(
            wallet,
            token0.address,
            token1.address,
            liquidityToken.address,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  AMM: ${amm.address}`);

        // Seed AMM with liquidity by minting public balances directly
        console.log("Seeding AMM with liquidity...");
        await token0.methods.mint_to_public(amm.address, TOKEN0_LIQUIDITY).send({ from: addresses[0] }).wait();
        await token1.methods.mint_to_public(amm.address, TOKEN1_LIQUIDITY).send({ from: addresses[0] }).wait();

        // Give the swapper (addresses[1]) some token0 to swap (enough for both swaps)
        console.log("Minting tokens to swapper...");
        await token0.methods.mint_to_private(addresses[1], SWAP1_AMOUNT_IN + SWAP2_AMOUNT_IN).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("prove and aggregate swap events", { timeout: 600000 }, async () => {
        const swapper = addresses[1];

        // ========================================
        // STEP 1: Execute first swap (exact tokens in)
        // ========================================
        console.log("\n=== STEP 1: Execute first swap ===");

        const nonce1 = Fr.random();
        const authwit1 = await wallet.createAuthWit(swapper, {
            caller: amm.address,
            action: token0.methods.transfer_to_public(swapper, amm.address, SWAP1_AMOUNT_IN, nonce1),
        });

        const amountOutMin1 = await amm.methods
            .get_amount_out_for_exact_in(TOKEN0_LIQUIDITY, TOKEN1_LIQUIDITY, SWAP1_AMOUNT_IN)
            .simulate({ from: swapper });
        console.log(`  Swap 1 - Amount in: ${SWAP1_AMOUNT_IN}, Expected out: ${amountOutMin1}`);

        await amm.methods
            .swap_exact_tokens_for_tokens(token0.address, token1.address, SWAP1_AMOUNT_IN, amountOutMin1, nonce1)
            .with({ authWitnesses: [authwit1] })
            .send({ from: swapper })
            .wait();
        console.log("  Swap 1 executed!");

        // ========================================
        // STEP 2: Execute second swap (exact tokens in, smaller amount)
        // ========================================
        console.log("\n=== STEP 2: Execute second swap ===");

        // After first swap, reserves have changed. Query new reserves.
        const newToken0Reserve = TOKEN0_LIQUIDITY + SWAP1_AMOUNT_IN;
        const newToken1Reserve = TOKEN1_LIQUIDITY - BigInt(amountOutMin1);

        const nonce2 = Fr.random();
        const authwit2 = await wallet.createAuthWit(swapper, {
            caller: amm.address,
            action: token0.methods.transfer_to_public(swapper, amm.address, SWAP2_AMOUNT_IN, nonce2),
        });

        const amountOutMin2 = await amm.methods
            .get_amount_out_for_exact_in(newToken0Reserve, newToken1Reserve, SWAP2_AMOUNT_IN)
            .simulate({ from: swapper });
        console.log(`  Swap 2 - Amount in: ${SWAP2_AMOUNT_IN}, Expected out: ${amountOutMin2}`);

        await amm.methods
            .swap_exact_tokens_for_tokens(token0.address, token1.address, SWAP2_AMOUNT_IN, amountOutMin2, nonce2)
            .with({ authWitnesses: [authwit2] })
            .send({ from: swapper })
            .wait();
        console.log("  Swap 2 executed!");

        // ========================================
        // STEP 3: Discover swap events via tag scanning
        // ========================================
        console.log("\n=== STEP 3: Discover swap events ===");

        const taggingSecrets = await wallet.exportTaggingSecrets(swapper, [amm.address], [swapper]);
        console.log(`  Exported ${taggingSecrets.secrets.length} tagging secrets`);

        const events = await retrieveEncryptedEvents(node, taggingSecrets);
        console.log(`  Found ${events.totalEvents} events`);

        expect(events.totalEvents).toBeGreaterThanOrEqual(2);

        const allEvents = events.secrets.flatMap(s => s.events);
        console.log(`  Event 1: ${allEvents[0].ciphertextBytes} bytes, block ${allEvents[0].blockNumber}`);
        console.log(`  Event 2: ${allEvents[1].ciphertextBytes} bytes, block ${allEvents[1].blockNumber}`);

        // ========================================
        // STEP 4: Generate individual swap proofs
        // ========================================
        console.log("\n=== STEP 4: Generate individual swap proofs ===");

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
        });

        // Prove first swap
        const event1BlockNumber = BigInt(allEvents[0].blockNumber);
        const result1 = await prover.prove(allEvents[0].ciphertextBuffer, event1BlockNumber);

        console.log(`\n  Swap 1 proof:`);
        console.log(`    leaf: ${result1.publicInputs.leaf}`);
        console.log(`    vkeyMarker: ${result1.publicInputs.vkeyMarker}`);
        console.log(`    token_in: ${result1.swapData.tokenIn}`);
        console.log(`    amount_in: ${result1.swapData.amountIn}`);
        console.log(`    amount_out: ${result1.swapData.amountOut}`);

        // Prove second swap
        const event2BlockNumber = BigInt(allEvents[1].blockNumber);
        const result2 = await prover.prove(allEvents[1].ciphertextBuffer, event2BlockNumber);

        console.log(`\n  Swap 2 proof:`);
        console.log(`    leaf: ${result2.publicInputs.leaf}`);
        console.log(`    vkeyMarker: ${result2.publicInputs.vkeyMarker}`);
        console.log(`    token_in: ${result2.swapData.tokenIn}`);
        console.log(`    amount_in: ${result2.swapData.amountIn}`);
        console.log(`    amount_out: ${result2.swapData.amountOut}`);

        // Verify individual proof results
        expect(result1.publicInputs.vkeyMarker).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
        expect(result2.publicInputs.vkeyMarker).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');

        expect(result1.swapData.tokenIn).toBe(token0.address.toField().toString());
        expect(result1.swapData.tokenOut).toBe(token1.address.toField().toString());
        expect(result1.swapData.amountIn).toBe(BigInt(SWAP1_AMOUNT_IN));
        expect(result1.swapData.amountOut).toBe(BigInt(amountOutMin1));
        expect(result1.swapData.isExactInput).toBe(1n);

        expect(result2.swapData.tokenIn).toBe(token0.address.toField().toString());
        expect(result2.swapData.tokenOut).toBe(token1.address.toField().toString());
        expect(result2.swapData.amountIn).toBe(BigInt(SWAP2_AMOUNT_IN));
        expect(result2.swapData.amountOut).toBe(BigInt(amountOutMin2));
        expect(result2.swapData.isExactInput).toBe(1n);

        // Verify leaf hashes
        const expectedLeaf1 = await poseidon2Hash([
            new Fr(event1BlockNumber),
            token0.address.toField(),
            token1.address.toField(),
            new Fr(SWAP1_AMOUNT_IN),
            new Fr(amountOutMin1),
            new Fr(1n),
        ]);
        expect(result1.publicInputs.leaf).toBe(expectedLeaf1.toString());

        const expectedLeaf2 = await poseidon2Hash([
            new Fr(event2BlockNumber),
            token0.address.toField(),
            token1.address.toField(),
            new Fr(SWAP2_AMOUNT_IN),
            new Fr(amountOutMin2),
            new Fr(1n),
        ]);
        expect(result2.publicInputs.leaf).toBe(expectedLeaf2.toString());

        console.log("\n  Individual proof assertions passed!");

        // ========================================
        // STEP 5: Aggregate proofs with SwapProofTree
        // ========================================
        console.log("\n=== STEP 5: Aggregate swap proofs ===");

        const proofTree = new SwapProofTree({
            bb,
            leafCircuit: individualSwapCircuit as CompiledCircuit,
            summaryCircuit: swapSummaryTreeCircuit as CompiledCircuit,
            swapProver: prover,
        });

        const aggregateResult = await proofTree.prove([
            { encryptedLog: allEvents[0].ciphertextBuffer, blockNumber: event1BlockNumber },
            { encryptedLog: allEvents[1].ciphertextBuffer, blockNumber: event2BlockNumber },
        ]);

        console.log(`\n=== AGGREGATE PROOF RESULT ===`);
        console.log(`  root: ${aggregateResult.publicInputs.root}`);
        console.log(`  vkeyHash: ${aggregateResult.publicInputs.vkeyHash}`);
        console.log(`  Proof size: ${aggregateResult.proof.length} bytes`);

        // Verify merkle root matches TS-computed poseidon2Hash([leaf1, leaf2])
        const expectedRoot = await poseidon2Hash([expectedLeaf1, expectedLeaf2]);
        expect(aggregateResult.publicInputs.root).toBe(expectedRoot.toString());

        console.log(`\n  Expected root: ${expectedRoot.toString()}`);
        console.log(`  Actual root:   ${aggregateResult.publicInputs.root}`);
        console.log("\n  All aggregation assertions passed!");
    });

});
