import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { AMMContract } from '@aztec/noir-contracts.js/AMM';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import { Barretenberg } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { SpotPriceProver } from '../src/spot-price';

import spotPriceCircuit from '../circuits/spot_price/target/spot_price.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Spot Price Proof Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token0: TokenContract;
    let token1: TokenContract;
    let liquidityToken: TokenContract;
    let amm: AMMContract;
    let bb: Barretenberg;

    // Amounts to seed the AMM with
    const TOKEN0_BALANCE = precision(1000n); // 1000 token0
    const TOKEN1_BALANCE = precision(2000n); // 2000 token1
    // Expected price: token1_balance / token0_balance = 2000/1000 = 2.0
    // With 18 decimals of precision: 2 * 10^18

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

        // Deploy token0 (using @aztec/noir-contracts.js Token which AMM depends on)
        console.log("Deploying token0...");
        token0 = await TokenContract.deploy(
            wallet,
            addresses[0], // admin
            "Token Zero",
            "TK0",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token0: ${token0.address}`);

        // Deploy token1
        console.log("Deploying token1...");
        token1 = await TokenContract.deploy(
            wallet,
            addresses[0], // admin
            "Token One",
            "TK1",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  token1: ${token1.address}`);

        // Deploy liquidity token (needed for AMM constructor)
        console.log("Deploying liquidity token...");
        liquidityToken = await TokenContract.deploy(
            wallet,
            addresses[0], // admin
            "LP Token",
            "LP",
            18,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  liquidity token: ${liquidityToken.address}`);

        // Deploy AMM
        console.log("Deploying AMM...");
        amm = await AMMContract.deploy(
            wallet,
            token0.address,
            token1.address,
            liquidityToken.address,
        ).send({ from: addresses[0] }).deployed();
        console.log(`  AMM: ${amm.address}`);

        // Seed the AMM with public balances by minting directly to the AMM address.
        // This simulates the state after liquidity has been added, without going through
        // the full add_liquidity flow (which requires authwits and private functions).
        console.log("Minting token0 to AMM...");
        await token0.methods.mint_to_public(amm.address, TOKEN0_BALANCE).send({ from: addresses[0] }).wait();

        console.log("Minting token1 to AMM...");
        await token1.methods.mint_to_public(amm.address, TOKEN1_BALANCE).send({ from: addresses[0] }).wait();

        console.log("Setup complete!");
    });

    test("prove spot price", { timeout: 300000 }, async () => {
        const blockNumber = await node.getBlockNumber();
        console.log(`\nCurrent block number: ${blockNumber}`);

        const prover = new SpotPriceProver({
            bb,
            circuit: spotPriceCircuit as CompiledCircuit,
            node,
        });

        // Get the public_balances storage slot from the Token contract artifact
        const publicBalancesSlot = TokenContract.storage.public_balances.slot;
        console.log(`  public_balances slot: ${publicBalancesSlot}`);

        const result = await prover.prove(
            amm.address.toField(),
            token0.address.toField(),
            token1.address.toField(),
            blockNumber,
            publicBalancesSlot,
        );

        console.log(`\n=== SPOT PRICE PROOF RESULT ===`);
        console.log(`  Price: ${result.publicInputs.price}`);
        console.log(`  Block: ${result.publicInputs.blockNumber}`);
        console.log(`  Root: ${result.publicInputs.publicDataTreeRoot}`);
        console.log(`  AMM: ${result.publicInputs.ammAddress}`);
        console.log(`  Token0: ${result.publicInputs.token0Address}`);
        console.log(`  Token1: ${result.publicInputs.token1Address}`);
        console.log(`  Proof size: ${result.proof.length} bytes`);

        // Expected price: 2000 * 10^18 / 1000 = 2 * 10^18
        const expectedPrice = TOKEN1_BALANCE * precision(1n) / TOKEN0_BALANCE;
        expect(result.publicInputs.price).toBe(expectedPrice);
        console.log(`\n  Expected price: ${expectedPrice}`);
        console.log(`  Proven price:   ${result.publicInputs.price}`);
        console.log(`  Match: ${result.publicInputs.price === expectedPrice}`);
    });

});
