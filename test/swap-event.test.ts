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
import { retrieveEncryptedEvents } from '../src/event-reader';
import { SwapProver } from '../src/swap-prover';

import individualSwapCircuit from '../circuits/individual_swap/target/individual_swap.json' with { type: 'json' };

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

    // Initial AMM liquidity
    const TOKEN0_LIQUIDITY = precision(1000n);
    const TOKEN1_LIQUIDITY = precision(2000n);

    // Swap amount
    const SWAP_AMOUNT_IN = precision(10n);

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

        // Give the swapper (addresses[1]) some token0 to swap
        console.log("Minting tokens to swapper...");
        await token0.methods.mint_to_private(addresses[1], SWAP_AMOUNT_IN).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("prove swap event", { timeout: 300000 }, async () => {
        const swapper = addresses[1];

        // 1. Execute swap: exact tokens in
        console.log("\n=== STEP 1: Execute swap ===");

        // Create authwit for the token transfer to the AMM
        const nonceForAuthwit = Fr.random();
        const swapAuthwit = await wallet.createAuthWit(swapper, {
            caller: amm.address,
            action: token0.methods.transfer_to_public(swapper, amm.address, SWAP_AMOUNT_IN, nonceForAuthwit),
        });

        // Compute expected amount out
        const amountOutMin = await amm.methods
            .get_amount_out_for_exact_in(TOKEN0_LIQUIDITY, TOKEN1_LIQUIDITY, SWAP_AMOUNT_IN)
            .simulate({ from: swapper });
        console.log(`  Amount in: ${SWAP_AMOUNT_IN}`);
        console.log(`  Expected amount out (min): ${amountOutMin}`);

        // Execute the swap
        await amm.methods
            .swap_exact_tokens_for_tokens(token0.address, token1.address, SWAP_AMOUNT_IN, amountOutMin, nonceForAuthwit)
            .with({ authWitnesses: [swapAuthwit] })
            .send({ from: swapper })
            .wait();
        console.log("  Swap executed!");

        // 2. Discover swap events via tag scanning
        console.log("\n=== STEP 2: Discover swap events ===");

        // Export tagging secrets for the swapper, scoped to the AMM contract
        // Counterparty is the swapper themselves (since deliver_to(sender) means sender=recipient=swapper)
        const taggingSecrets = await wallet.exportTaggingSecrets(swapper, [amm.address], [swapper]);
        console.log(`  Exported ${taggingSecrets.secrets.length} tagging secrets`);

        const events = await retrieveEncryptedEvents(node, taggingSecrets);
        console.log(`  Found ${events.totalEvents} events`);

        expect(events.totalEvents).toBeGreaterThan(0);

        // Get the first event's ciphertext
        const allEvents = events.secrets.flatMap(s => s.events);
        const swapEvent = allEvents[0];
        console.log(`  First event: ${swapEvent.ciphertextBytes} bytes, block ${swapEvent.blockNumber}`);

        // 3. Generate proof of swap
        console.log("\n=== STEP 3: Generate swap proof ===");

        // Get recipient's complete address and ivskM for decryption
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

        const result = await prover.prove(swapEvent.ciphertextBuffer);

        console.log(`\n=== SWAP PROOF RESULT ===`);
        console.log(`  token_in: ${result.publicInputs.tokenIn}`);
        console.log(`  token_out: ${result.publicInputs.tokenOut}`);
        console.log(`  amount_in: ${result.publicInputs.amountIn}`);
        console.log(`  amount_out: ${result.publicInputs.amountOut}`);
        console.log(`  is_exact_input: ${result.publicInputs.isExactInput}`);
        console.log(`  Proof size: ${result.proof.length} bytes`);

        // 4. Verify proven values match expected swap parameters
        expect(result.publicInputs.tokenIn).toBe(token0.address.toField().toString());
        expect(result.publicInputs.tokenOut).toBe(token1.address.toField().toString());
        expect(result.publicInputs.amountIn).toBe(BigInt(SWAP_AMOUNT_IN));
        // For exact-in swaps, the contract emits amount_out_min (not the actual output)
        expect(result.publicInputs.amountOut).toBe(BigInt(amountOutMin));
        expect(result.publicInputs.isExactInput).toBe(1n);

        console.log("\n  All assertions passed!");
    });

});
