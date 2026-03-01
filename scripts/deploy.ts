/**
 * Setup script: deploys all infrastructure for the PnL proof system.
 *
 * Deploys:
 *   - 4 tokens: USDC (denom), wETH, wZEC, wAZTEC
 *   - 3 AMM pools: wETH/USDC, wZEC/USDC, wAZTEC/USDC (each with its own LP token)
 *   - 1 PriceFeed oracle
 *
 * Fetches live prices from CoinGecko, sets oracle prices accordingly,
 * and seeds each pool with liquidity matching the real price ratio.
 *
 * Writes deployed addresses to frontend/.env.local and deployment.json.
 *
 * Env vars:
 *   AZTEC_NODE_URL       (default: http://localhost:8080)
 *   COINGECKO_API_KEY    (required for price fetch)
 *
 * Usage: bun scripts/deploy.ts
 */

import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { type AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed';
import { TokenContract } from '../src/artifacts/Token';
import { AMMContract } from '../src/artifacts/AMM';
import { AuditableTestWallet } from '@aztec/note-collector';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';

const {
    AZTEC_NODE_URL = 'http://localhost:8080',
    COINGECKO_API_KEY,
} = process.env;

if (!COINGECKO_API_KEY) {
    console.error('Error: COINGECKO_API_KEY env var is required');
    process.exit(1);
}

// Oracle price precision: 1 USD = 10,000 units (4 decimals)
// Limited by i64 overflow in PnL circuit: token_amount(9 decimals) * price_diff
// must fit in i64 (max ~9.2e18). Cheap tokens like wAZTEC ($0.10) yield large
// amounts (~2e14 base units), constraining precision to ~10,000.
const PRICE_PRECISION = 10_000;

// Pool seed: $100k USDC per pool
const POOL_USDC_AMOUNT = 100_000n;
const USDC_DECIMALS = 6;
const TOKEN_DECIMALS = 9;

// CoinGecko IDs — no listed AZTEC token, use fallback
const COINGECKO_IDS = {
    wETH: 'ethereum',
    wZEC: 'zcash',
} as const;
const WAZTEC_FALLBACK_USD = 0.10;

interface CoinGeckoPrices {
    [id: string]: { usd: number };
}

async function fetchPrices(): Promise<{ wETH: number; wZEC: number; wAZTEC: number; USDC: number }> {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const res = await fetch(url, {
        headers: { 'x-cg-demo-api-key': COINGECKO_API_KEY! },
    });
    if (!res.ok) {
        throw new Error(`CoinGecko API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as CoinGeckoPrices;

    const ethPrice = data[COINGECKO_IDS.wETH]?.usd;
    const zecPrice = data[COINGECKO_IDS.wZEC]?.usd;
    if (!ethPrice || !zecPrice) {
        throw new Error(`Missing prices from CoinGecko: ${JSON.stringify(data)}`);
    }

    return {
        USDC: 1.0,
        wETH: ethPrice,
        wZEC: zecPrice,
        wAZTEC: WAZTEC_FALLBACK_USD,
    };
}

/** Convert a USD price to oracle units (price * PRICE_PRECISION), rounded to nearest integer as bigint */
function toOraclePrice(usdPrice: number): bigint {
    return BigInt(Math.round(usdPrice * PRICE_PRECISION));
}

/** Calculate how many whole tokens (in base units) to seed into a pool given $POOL_USDC_AMOUNT on each side */
function poolAmounts(tokenPriceUsd: number, tokenDecimals: number) {
    // USDC side: POOL_USDC_AMOUNT with USDC_DECIMALS
    const usdcAmount = POOL_USDC_AMOUNT * 10n ** BigInt(USDC_DECIMALS);
    // Token side: POOL_USDC_AMOUNT / tokenPriceUsd tokens, scaled to token decimals
    const tokenCount = Number(POOL_USDC_AMOUNT) / tokenPriceUsd;
    const tokenAmount = BigInt(Math.round(tokenCount * 10 ** tokenDecimals));
    return { usdcAmount, tokenAmount };
}

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
    prices: { USDC: number; wETH: number; wZEC: number; wAZTEC: number };
    oraclePrices: { USDC: string; wETH: string; wZEC: string; wAZTEC: string };
}

async function setup() {
    console.log('=== PnL Proof Infrastructure Setup ===\n');

    // --- Fetch live prices ---
    console.log('--- Fetching live prices from CoinGecko ---');
    const prices = await fetchPrices();
    console.log(`  USDC   = $${prices.USDC}`);
    console.log(`  wETH   = $${prices.wETH}`);
    console.log(`  wZEC   = $${prices.wZEC}`);
    console.log(`  wAZTEC = $${prices.wAZTEC} (fallback)\n`);

    const oraclePrices = {
        USDC: toOraclePrice(prices.USDC),
        wETH: toOraclePrice(prices.wETH),
        wZEC: toOraclePrice(prices.wZEC),
        wAZTEC: toOraclePrice(prices.wAZTEC),
    };

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

    // --- Set oracle prices from CoinGecko ---
    console.log('--- Setting oracle prices ---');

    console.log(`  USDC   = ${oraclePrices.USDC} ($${prices.USDC})`);
    await priceFeed.methods.set_price(usdc.address.toField(), oraclePrices.USDC)
        .send({ from: admin }).wait();

    console.log(`  wETH   = ${oraclePrices.wETH} ($${prices.wETH})`);
    await priceFeed.methods.set_price(weth.address.toField(), oraclePrices.wETH)
        .send({ from: admin }).wait();

    console.log(`  wZEC   = ${oraclePrices.wZEC} ($${prices.wZEC})`);
    await priceFeed.methods.set_price(wzec.address.toField(), oraclePrices.wZEC)
        .send({ from: admin }).wait();

    console.log(`  wAZTEC = ${oraclePrices.wAZTEC} ($${prices.wAZTEC})`);
    await priceFeed.methods.set_price(waztec.address.toField(), oraclePrices.wAZTEC)
        .send({ from: admin }).wait();
    console.log();

    // --- Deploy AMM pools ---
    console.log('--- Deploying AMM pools ---');

    // wETH/USDC pool
    console.log('Deploying wETH/USDC LP token...');
    const lpEthUsdc = await TokenContract.deploy(wallet, admin, 'LP wETH-USDC', 'LP-EU', 18)
        .send({ from: admin }).deployed();
    console.log('Deploying wETH/USDC AMM...');
    const ammEthUsdc = await AMMContract.deploy(wallet, weth.address, usdc.address, lpEthUsdc.address)
        .send({ from: admin }).deployed();
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

    // --- Seed pools with liquidity at correct price ratios ---
    console.log('--- Seeding pools with liquidity ($100k USDC per pool) ---');

    const ethPool = poolAmounts(prices.wETH, TOKEN_DECIMALS);
    console.log(`  wETH/USDC: ${Number(ethPool.tokenAmount) / 1e18} wETH + ${Number(ethPool.usdcAmount) / 1e6} USDC`);
    await weth.methods.mint_to_public(ammEthUsdc.address, ethPool.tokenAmount).send({ from: admin }).wait();
    await usdc.methods.mint_to_public(ammEthUsdc.address, ethPool.usdcAmount).send({ from: admin }).wait();

    const zecPool = poolAmounts(prices.wZEC, TOKEN_DECIMALS);
    console.log(`  wZEC/USDC: ${Number(zecPool.tokenAmount) / 1e18} wZEC + ${Number(zecPool.usdcAmount) / 1e6} USDC`);
    await wzec.methods.mint_to_public(ammZecUsdc.address, zecPool.tokenAmount).send({ from: admin }).wait();
    await usdc.methods.mint_to_public(ammZecUsdc.address, zecPool.usdcAmount).send({ from: admin }).wait();

    const aztecPool = poolAmounts(prices.wAZTEC, TOKEN_DECIMALS);
    console.log(`  wAZTEC/USDC: ${Number(aztecPool.tokenAmount) / 1e18} wAZTEC + ${Number(aztecPool.usdcAmount) / 1e6} USDC`);
    await waztec.methods.mint_to_public(ammAztecUsdc.address, aztecPool.tokenAmount).send({ from: admin }).wait();
    await usdc.methods.mint_to_public(ammAztecUsdc.address, aztecPool.usdcAmount).send({ from: admin }).wait();
    console.log();

    // --- Save deployment.json ---
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
        prices,
        oraclePrices: {
            USDC: oraclePrices.USDC.toString(),
            wETH: oraclePrices.wETH.toString(),
            wZEC: oraclePrices.wZEC.toString(),
            wAZTEC: oraclePrices.wAZTEC.toString(),
        },
    };

    const outPath = join(process.cwd(), 'deployment.json');
    await writeFile(outPath, JSON.stringify(infra, null, 2));
    console.log(`Deployment info saved to ${outPath}`);

    // --- Upsert deployed addresses into frontend/.env.local ---
    const envPath = join(process.cwd(), 'frontend', '.env.local');
    const deployedVars: Record<string, string> = {
        NEXT_PUBLIC_PRICE_FEED: priceFeed.address.toString(),
        NEXT_PUBLIC_TOKEN_USDC: usdc.address.toString(),
        NEXT_PUBLIC_TOKEN_WETH: weth.address.toString(),
        NEXT_PUBLIC_TOKEN_WZEC: wzec.address.toString(),
        NEXT_PUBLIC_TOKEN_WAZTEC: waztec.address.toString(),
        NEXT_PUBLIC_AMM_ETH_USDC: ammEthUsdc.address.toString(),
        NEXT_PUBLIC_AMM_ZEC_USDC: ammZecUsdc.address.toString(),
        NEXT_PUBLIC_AMM_AZTEC_USDC: ammAztecUsdc.address.toString(),
        NEXT_PUBLIC_LP_ETH_USDC: lpEthUsdc.address.toString(),
        NEXT_PUBLIC_LP_ZEC_USDC: lpZecUsdc.address.toString(),
        NEXT_PUBLIC_LP_AZTEC_USDC: lpAztecUsdc.address.toString(),
    };
    let existing = '';
    try { existing = await readFile(envPath, 'utf-8'); } catch {}
    const lines = existing.split('\n');
    const keysToSet = new Set(Object.keys(deployedVars));
    // Update existing lines in place
    const updated = lines.map(line => {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
        if (match && keysToSet.has(match[1])) {
            keysToSet.delete(match[1]);
            return `${match[1]}=${deployedVars[match[1]]}`;
        }
        return line;
    });
    // Append any keys that weren't already present
    for (const key of keysToSet) {
        updated.push(`${key}=${deployedVars[key]}`);
    }
    // Ensure trailing newline
    const result = updated.filter((l, i, a) => i < a.length - 1 || l !== '').join('\n') + '\n';
    await writeFile(envPath, result);
    console.log(`Frontend env updated at ${envPath}`);

    console.log('\n=== Setup complete! ===');
    return infra;
}

setup().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
});
