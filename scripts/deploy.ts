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
 * Writes deployed addresses to frontend/.env.production (devnet) or frontend/.env.development (sandbox) and deployment.json.
 *
 * Env vars:
 *   AZTEC_NODE_URL       (default: http://localhost:8080)
 *   COINGECKO_API_KEY    (required for price fetch)
 *
 * Usage: yarn deploy
 */

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed';
import { TokenContract } from '@privpnl/contracts/Token';
import { AMMContract } from '@privpnl/contracts/AMM';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/foundation/curves/bn254';
import { PRICE_PRECISION, USDC_DECIMALS, TOKEN_DECIMALS } from '@privpnl/proof/constants';
import {
    type AccountInfo, type DeployedInfra,
    initializeWallet, makeSendOpts, registerSandboxAccounts,
} from './utils';

const {
    AZTEC_NODE_URL = 'http://localhost:8080',
    COINGECKO_API_KEY,
} = process.env;

if (!COINGECKO_API_KEY) {
    console.error('Error: COINGECKO_API_KEY env var is required');
    process.exit(1);
}

// Pool seed: $10M USDC per pool (large enough to minimize slippage on $10-20k swaps)
const POOL_USDC_AMOUNT = 10_000_000n;

// CoinGecko IDs
const COINGECKO_IDS = {
    wETH: 'ethereum',
    wZEC: 'zcash',
    wAZTEC: 'aztec',
} as const;

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
    const aztecPrice = data[COINGECKO_IDS.wAZTEC]?.usd;
    if (!ethPrice || !zecPrice || !aztecPrice) {
        throw new Error(`Missing prices from CoinGecko: ${JSON.stringify(data)}`);
    }

    return {
        USDC: 1.0,
        wETH: ethPrice,
        wZEC: zecPrice,
        wAZTEC: aztecPrice,
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


async function setup() {
    console.log('=== PnL Proof Infrastructure Setup ===\n');

    // --- Fetch live prices ---
    console.log('--- Fetching live prices from CoinGecko ---');
    const prices = await fetchPrices();
    console.log(`  USDC   = $${prices.USDC}`);
    console.log(`  wETH   = $${prices.wETH}`);
    console.log(`  wZEC   = $${prices.wZEC}`);
    console.log(`  wAZTEC = $${prices.wAZTEC}\n`);

    const oraclePrices = {
        USDC: toOraclePrice(prices.USDC),
        wETH: toOraclePrice(prices.wETH),
        wZEC: toOraclePrice(prices.wZEC),
        wAZTEC: toOraclePrice(prices.wAZTEC),
    };

    const { node, wallet, isDevnet, fpcAddress } = await initializeWallet(AZTEC_NODE_URL);
    const sendOpts = makeSendOpts(isDevnet, fpcAddress);

    const addresses: AztecAddress[] = [];
    const demoAccounts: AccountInfo[] = [];
    let adminAccount: AccountInfo | undefined;

    if (isDevnet) {
        console.log('Devnet detected — deploying fresh accounts...');
        const fpcPaymentMethod = new SponsoredFeePaymentMethod(fpcAddress!);

        // Deploy 3 fresh accounts: admin + 2 demo accounts
        for (let i = 0; i < 3; i++) {
            const secret = Fr.random();
            const signingKey = Fr.random();
            const manager = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKey);
            const deployMethod = await manager.getDeployMethod();
            console.log(`  Deploying account ${i} at ${manager.address}...`);
            const deployReceipt = await deployMethod.send({
                from: AztecAddress.ZERO,
                fee: { paymentMethod: fpcPaymentMethod },
                skipClassPublication: i !== 0,
                wait: { returnReceipt: true, timeout: 600 },
            });
            console.log(`  Account ${i} status: ${deployReceipt.status}, result: ${deployReceipt.executionResult}, tx: ${deployReceipt.txHash}`);
            if (deployReceipt.executionResult !== 'success') {
                throw new Error(`Account ${i} deploy failed: ${deployReceipt.executionResult} (revert: ${deployReceipt.revertReason})`);
            }
            addresses.push(manager.address);

            const accountInfo: AccountInfo = {
                address: manager.address.toString(),
                secretKey: secret.toString(),
                signingKey: signingKey.toString(),
                salt: Fr.ZERO.toString(),
            };

            if (i === 0) {
                adminAccount = accountInfo;
            } else {
                demoAccounts.push(accountInfo);
            }
        }

        // Force PXE to discover account signing key notes via full contract sync
        const pxeDebug = (wallet.pxe as any).debug;
        for (let i = 0; i < addresses.length; i++) {
            const notes = await pxeDebug.getNotes({
                contractAddress: addresses[i],
                scopes: [addresses[i]],
            });
            console.log(`  Account ${i} notes after sync: ${notes.length}`);
            if (notes.length === 0) {
                throw new Error(`Account ${i} at ${addresses[i]} has no notes — deployment may have failed silently`);
            }
        }
    } else {
        // Sandbox: use pre-deployed test accounts
        addresses.push(...await registerSandboxAccounts(wallet));
    }

    const admin = addresses[0];
    console.log(`Admin (minter): ${admin}\n`);

    // --- Deploy tokens ---
    console.log('--- Deploying tokens ---');

    console.log('Deploying USDC...');
    const usdc = await TokenContract.deploy(wallet, admin, 'USD Coin', 'USDC', 6)
        .send(sendOpts(admin));
    console.log(`  USDC: ${usdc.address}`);

    console.log('Deploying wETH...');
    const weth = await TokenContract.deploy(wallet, admin, 'Wrapped Ether', 'wETH', 18)
        .send(sendOpts(admin));
    console.log(`  wETH: ${weth.address}`);

    console.log('Deploying wZEC...');
    const wzec = await TokenContract.deploy(wallet, admin, 'Wrapped Zcash', 'wZEC', 18)
        .send(sendOpts(admin));
    console.log(`  wZEC: ${wzec.address}`);

    console.log('Deploying wAZTEC...');
    const waztec = await TokenContract.deploy(wallet, admin, 'Wrapped Aztec', 'wAZTEC', 18)
        .send(sendOpts(admin));
    console.log(`  wAZTEC: ${waztec.address}\n`);

    // --- Deploy PriceFeed oracle ---
    console.log('--- Deploying PriceFeed oracle ---');
    const priceFeed = await PriceFeedContract.deploy(wallet)
        .send(sendOpts(admin));
    console.log(`  PriceFeed: ${priceFeed.address}\n`);

    // --- Set oracle prices from CoinGecko ---
    console.log('--- Setting oracle prices ---');

    console.log(`  USDC   = ${oraclePrices.USDC} ($${prices.USDC})`);
    await priceFeed.methods.set_price(usdc.address.toField(), oraclePrices.USDC)
        .send(sendOpts(admin));

    console.log(`  wETH   = ${oraclePrices.wETH} ($${prices.wETH})`);
    await priceFeed.methods.set_price(weth.address.toField(), oraclePrices.wETH)
        .send(sendOpts(admin));

    console.log(`  wZEC   = ${oraclePrices.wZEC} ($${prices.wZEC})`);
    await priceFeed.methods.set_price(wzec.address.toField(), oraclePrices.wZEC)
        .send(sendOpts(admin));

    console.log(`  wAZTEC = ${oraclePrices.wAZTEC} ($${prices.wAZTEC})`);
    await priceFeed.methods.set_price(waztec.address.toField(), oraclePrices.wAZTEC)
        .send(sendOpts(admin));
    console.log();

    // --- Deploy AMM pools ---
    console.log('--- Deploying AMM pools ---');

    // wETH/USDC pool
    console.log('Deploying wETH/USDC LP token...');
    const lpEthUsdc = await TokenContract.deploy(wallet, admin, 'LP wETH-USDC', 'LP-EU', 18)
        .send(sendOpts(admin));
    console.log('Deploying wETH/USDC AMM...');
    const ammEthUsdc = await AMMContract.deploy(wallet, weth.address, usdc.address, lpEthUsdc.address)
        .send(sendOpts(admin));
    await lpEthUsdc.methods.set_minter(ammEthUsdc.address, true)
        .send(sendOpts(admin));
    console.log(`  wETH/USDC AMM: ${ammEthUsdc.address} (LP: ${lpEthUsdc.address})`);

    // wZEC/USDC pool
    console.log('Deploying wZEC/USDC LP token...');
    const lpZecUsdc = await TokenContract.deploy(wallet, admin, 'LP wZEC-USDC', 'LP-ZU', 18)
        .send(sendOpts(admin));
    console.log('Deploying wZEC/USDC AMM...');
    const ammZecUsdc = await AMMContract.deploy(wallet, wzec.address, usdc.address, lpZecUsdc.address)
        .send(sendOpts(admin));
    await lpZecUsdc.methods.set_minter(ammZecUsdc.address, true)
        .send(sendOpts(admin));
    console.log(`  wZEC/USDC AMM: ${ammZecUsdc.address} (LP: ${lpZecUsdc.address})`);

    // wAZTEC/USDC pool
    console.log('Deploying wAZTEC/USDC LP token...');
    const lpAztecUsdc = await TokenContract.deploy(wallet, admin, 'LP wAZTEC-USDC', 'LP-AU', 18)
        .send(sendOpts(admin));
    console.log('Deploying wAZTEC/USDC AMM...');
    const ammAztecUsdc = await AMMContract.deploy(wallet, waztec.address, usdc.address, lpAztecUsdc.address)
        .send(sendOpts(admin));
    await lpAztecUsdc.methods.set_minter(ammAztecUsdc.address, true)
        .send(sendOpts(admin));
    console.log(`  wAZTEC/USDC AMM: ${ammAztecUsdc.address} (LP: ${lpAztecUsdc.address})\n`);

    // --- Seed pools with liquidity at correct price ratios ---
    console.log('--- Seeding pools with liquidity ($10M USDC per pool) ---');

    const ethPool = poolAmounts(prices.wETH, TOKEN_DECIMALS);
    console.log(`  wETH/USDC: ${Number(ethPool.tokenAmount) / 10 ** TOKEN_DECIMALS} wETH + ${Number(ethPool.usdcAmount) / 10 ** USDC_DECIMALS} USDC`);
    await weth.methods.mint_to_public(ammEthUsdc.address, ethPool.tokenAmount).send(sendOpts(admin));
    await usdc.methods.mint_to_public(ammEthUsdc.address, ethPool.usdcAmount).send(sendOpts(admin));

    const zecPool = poolAmounts(prices.wZEC, TOKEN_DECIMALS);
    console.log(`  wZEC/USDC: ${Number(zecPool.tokenAmount) / 10 ** TOKEN_DECIMALS} wZEC + ${Number(zecPool.usdcAmount) / 10 ** USDC_DECIMALS} USDC`);
    await wzec.methods.mint_to_public(ammZecUsdc.address, zecPool.tokenAmount).send(sendOpts(admin));
    await usdc.methods.mint_to_public(ammZecUsdc.address, zecPool.usdcAmount).send(sendOpts(admin));

    const aztecPool = poolAmounts(prices.wAZTEC, TOKEN_DECIMALS);
    console.log(`  wAZTEC/USDC: ${Number(aztecPool.tokenAmount) / 10 ** TOKEN_DECIMALS} wAZTEC + ${Number(aztecPool.usdcAmount) / 10 ** USDC_DECIMALS} USDC`);
    await waztec.methods.mint_to_public(ammAztecUsdc.address, aztecPool.tokenAmount).send(sendOpts(admin));
    await usdc.methods.mint_to_public(ammAztecUsdc.address, aztecPool.usdcAmount).send(sendOpts(admin));
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
        ...(adminAccount ? { adminAccount } : {}),
        ...(demoAccounts.length > 0 ? { demoAccounts } : {}),
    };

    const outPath = join(process.cwd(), 'deployment.json');
    await writeFile(outPath, JSON.stringify(infra, null, 2));
    console.log(`Deployment info saved to ${outPath}`);

    // --- Upsert deployed addresses into frontend env file ---
    const envFile = isDevnet ? '.env.production' : '.env.development';
    const envPath = join(process.cwd(), 'packages', 'frontend', envFile);
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
    if (demoAccounts.length > 0) {
        deployedVars.NEXT_PUBLIC_DEMO_ACCOUNTS = JSON.stringify(demoAccounts);
    }
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
