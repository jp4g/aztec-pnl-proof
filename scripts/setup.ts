/**
 * Setup script: deploys all infrastructure for the PnL proof system.
 *
 * Deploys:
 *   - 4 tokens: USDC (denom), wETH, wZEC, wAZTEC
 *   - 3 AMM pools: wETH/USDC, wZEC/USDC, wAZTEC/USDC (each with its own LP token)
 *   - 1 PriceFeed oracle
 *
 * Sets oracle prices (scaled by PRICE_PRECISION = 10):
 *   USDC   = 10     ($1.00)
 *   wETH   = 20000  ($2000)
 *   wZEC   = 2000   ($200)
 *   wAZTEC = 1      ($0.10)
 *
 * All contracts use the first test account as admin/minter.
 *
 * Usage: bun scripts/setup.ts
 */

import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { type AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed';
import { TokenContract } from '../src/artifacts/Token';
import { AMMContract } from '../src/artifacts/AMM';
import { AuditableTestWallet } from '@aztec/note-collector';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const { AZTEC_NODE_URL = 'http://localhost:8080' } = process.env;

// Oracle prices (all multiplied by 10 so $0.10 = 1)
const PRICE_PRECISION = 10n; // 1 USD = 10 units
const PRICES = {
    USDC: 1n * PRICE_PRECISION,     // $1.00
    wETH: 2000n * PRICE_PRECISION,  // $2000
    wZEC: 200n * PRICE_PRECISION,   // $200
    wAZTEC: 1n,                     // $0.10 (0.1 * 10 = 1)
} as const;

interface DeployedInfra {
    admin: string;
    priceFeed: string;
    tokens: {
        USDC: string;
        wETH: string;
        wZEC: string;
        wAZTEC: string;
    };
    pools: {
        'wETH/USDC': { amm: string; lp: string };
        'wZEC/USDC': { amm: string; lp: string };
        'wAZTEC/USDC': { amm: string; lp: string };
    };
    prices: typeof PRICES;
}

async function setup() {
    console.log('=== PnL Proof Infrastructure Setup ===\n');

    // Connect to node
    const node: AztecNode = createAztecNodeClient(AZTEC_NODE_URL);
    console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

    // Create wallet with first test account as admin
    const wallet = await AuditableTestWallet.create(node, { proverEnabled: false });
    const accounts = await getInitialTestAccountsData();
    const addresses: AztecAddress[] = [];
    for (const account of accounts) {
        const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
        addresses.push(manager.address);
    }
    const admin = addresses[0];
    console.log(`Admin (minter): ${admin}\n`);

    // --- Deploy tokens ---
    console.log('--- Deploying tokens ---');

    console.log('Deploying USDC...');
    const usdc = await TokenContract.deploy(wallet, admin, 'USD Coin', 'USDC', 6)
        .send({ from: admin }).deployed();
    console.log(`  USDC: ${usdc.address}`);

    console.log('Deploying wETH...');
    const weth = await TokenContract.deploy(wallet, admin, 'Wrapped Ether', 'wETH', 18)
        .send({ from: admin }).deployed();
    console.log(`  wETH: ${weth.address}`);

    console.log('Deploying wZEC...');
    const wzec = await TokenContract.deploy(wallet, admin, 'Wrapped Zcash', 'wZEC', 18)
        .send({ from: admin }).deployed();
    console.log(`  wZEC: ${wzec.address}`);

    console.log('Deploying wAZTEC...');
    const waztec = await TokenContract.deploy(wallet, admin, 'Wrapped Aztec', 'wAZTEC', 18)
        .send({ from: admin }).deployed();
    console.log(`  wAZTEC: ${waztec.address}\n`);

    // --- Deploy PriceFeed oracle ---
    console.log('--- Deploying PriceFeed oracle ---');
    const priceFeed = await PriceFeedContract.deploy(wallet)
        .send({ from: admin }).deployed();
    console.log(`  PriceFeed: ${priceFeed.address}\n`);

    // --- Set oracle prices ---
    console.log('--- Setting oracle prices ---');

    console.log(`  USDC   = ${PRICES.USDC} (${Number(PRICES.USDC) / Number(PRICE_PRECISION)} USD)`);
    await priceFeed.methods.set_price(usdc.address.toField(), PRICES.USDC)
        .send({ from: admin }).wait();

    console.log(`  wETH   = ${PRICES.wETH} (${Number(PRICES.wETH) / Number(PRICE_PRECISION)} USD)`);
    await priceFeed.methods.set_price(weth.address.toField(), PRICES.wETH)
        .send({ from: admin }).wait();

    console.log(`  wZEC   = ${PRICES.wZEC} (${Number(PRICES.wZEC) / Number(PRICE_PRECISION)} USD)`);
    await priceFeed.methods.set_price(wzec.address.toField(), PRICES.wZEC)
        .send({ from: admin }).wait();

    console.log(`  wAZTEC = ${PRICES.wAZTEC} (${Number(PRICES.wAZTEC) / Number(PRICE_PRECISION)} USD)`);
    await priceFeed.methods.set_price(waztec.address.toField(), PRICES.wAZTEC)
        .send({ from: admin }).wait();
    console.log();

    // --- Deploy AMM pools (each needs its own LP token) ---
    console.log('--- Deploying AMM pools ---');

    // wETH/USDC pool
    console.log('Deploying wETH/USDC LP token...');
    const lpEthUsdc = await TokenContract.deploy(wallet, admin, 'LP wETH-USDC', 'LP-EU', 18)
        .send({ from: admin }).deployed();
    console.log('Deploying wETH/USDC AMM...');
    const ammEthUsdc = await AMMContract.deploy(wallet, weth.address, usdc.address, lpEthUsdc.address)
        .send({ from: admin }).deployed();
    // Grant minter role to the AMM so it can mint LP tokens
    await lpEthUsdc.methods.set_minter(ammEthUsdc.address, true)
        .send({ from: admin }).wait();
    console.log(`  wETH/USDC AMM: ${ammEthUsdc.address} (LP: ${lpEthUsdc.address})`);

    // wZEC/USDC pool
    console.log('Deploying wZEC/USDC LP token...');
    const lpZecUsdc = await TokenContract.deploy(wallet, admin, 'LP wZEC-USDC', 'LP-ZU', 18)
        .send({ from: admin }).deployed();
    console.log('Deploying wZEC/USDC AMM...');
    const ammZecUsdc = await AMMContract.deploy(wallet, wzec.address, usdc.address, lpZecUsdc.address)
        .send({ from: admin }).deployed();
    await lpZecUsdc.methods.set_minter(ammZecUsdc.address, true)
        .send({ from: admin }).wait();
    console.log(`  wZEC/USDC AMM: ${ammZecUsdc.address} (LP: ${lpZecUsdc.address})`);

    // wAZTEC/USDC pool
    console.log('Deploying wAZTEC/USDC LP token...');
    const lpAztecUsdc = await TokenContract.deploy(wallet, admin, 'LP wAZTEC-USDC', 'LP-AU', 18)
        .send({ from: admin }).deployed();
    console.log('Deploying wAZTEC/USDC AMM...');
    const ammAztecUsdc = await AMMContract.deploy(wallet, waztec.address, usdc.address, lpAztecUsdc.address)
        .send({ from: admin }).deployed();
    await lpAztecUsdc.methods.set_minter(ammAztecUsdc.address, true)
        .send({ from: admin }).wait();
    console.log(`  wAZTEC/USDC AMM: ${ammAztecUsdc.address} (LP: ${lpAztecUsdc.address})\n`);

    // --- Save deployment info ---
    const infra: DeployedInfra = {
        admin: admin.toString(),
        priceFeed: priceFeed.address.toString(),
        tokens: {
            USDC: usdc.address.toString(),
            wETH: weth.address.toString(),
            wZEC: wzec.address.toString(),
            wAZTEC: waztec.address.toString(),
        },
        pools: {
            'wETH/USDC': { amm: ammEthUsdc.address.toString(), lp: lpEthUsdc.address.toString() },
            'wZEC/USDC': { amm: ammZecUsdc.address.toString(), lp: lpZecUsdc.address.toString() },
            'wAZTEC/USDC': { amm: ammAztecUsdc.address.toString(), lp: lpAztecUsdc.address.toString() },
        },
        prices: PRICES,
    };

    const outPath = join(process.cwd(), 'deployment.json');
    await writeFile(outPath, JSON.stringify(infra, null, 2));
    console.log(`=== Setup complete! Deployment info saved to ${outPath} ===`);

    return infra;
}

setup().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
});
