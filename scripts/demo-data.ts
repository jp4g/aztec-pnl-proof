/**
 * Demo data script: executes 6 swaps with the 3rd test account against
 * already-deployed infrastructure, giving the demo user a swap history
 * to prove against.
 *
 * Reads deployment.json for contract addresses and initial oracle prices.
 *
 * Env vars:
 *   AZTEC_NODE_URL       (default: http://localhost:8080)
 *
 * Usage: bun scripts/demo-data.ts
 */

import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { type AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { PriceFeedContract, PriceFeedContractArtifact } from '@aztec/noir-contracts.js/PriceFeed';
import { TokenContract, TokenContractArtifact } from '../src/artifacts/Token';
import { AMMContract, AMMContractArtifact } from '../src/artifacts/AMM';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PoolState } from '../src/rebalance';

const { AZTEC_NODE_URL = 'http://localhost:8080' } = process.env;

const USDC_DECIMALS = 6;

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

// Price multipliers per swap phase
// Swaps 1-2: baseline (1.0x)
// Swaps 3-4: ETH pumps, ZEC dips
// Swaps 5-6: ETH dips, ZEC+AZTEC pump
const PRICE_MULTIPLIERS: { USDC: number; wETH: number; wZEC: number; wAZTEC: number }[] = [
    { USDC: 1.0, wETH: 1.0,  wZEC: 1.0,  wAZTEC: 1.0  },  // Swap 1
    { USDC: 1.0, wETH: 1.0,  wZEC: 1.0,  wAZTEC: 1.0  },  // Swap 2
    { USDC: 1.0, wETH: 1.15, wZEC: 0.90, wAZTEC: 1.0  },  // Swap 3
    { USDC: 1.0, wETH: 1.15, wZEC: 0.90, wAZTEC: 1.0  },  // Swap 4
    { USDC: 1.0, wETH: 0.95, wZEC: 1.25, wAZTEC: 1.80 },  // Swap 5
    { USDC: 1.0, wETH: 0.95, wZEC: 1.25, wAZTEC: 1.80 },  // Swap 6
];

type TokenKey = 'USDC' | 'wETH' | 'wZEC' | 'wAZTEC';
type PoolKey = 'wETH/USDC' | 'wZEC/USDC' | 'wAZTEC/USDC';

interface SwapDef {
    inKey: TokenKey;
    outKey: TokenKey;
    pool: PoolKey;
    amountIn: bigint;
    amountInDesc: string;
}

// USDC amount in base units (6 decimals)
const usdc = (n: number) => BigInt(n) * 10n ** BigInt(USDC_DECIMALS);

// Swap sequence:
// 1. USDC -> wETH on ETH/USDC pool, 10k USDC
// 2. USDC -> wZEC on ZEC/USDC pool, 15k USDC
// 3. wETH -> USDC on ETH/USDC pool, all wETH from swap 1 (filled at runtime)
// 4. USDC -> wAZTEC on AZTEC/USDC pool, 20k USDC
// 5. wZEC -> USDC on ZEC/USDC pool, all wZEC from swap 2 (filled at runtime)
// 6. wAZTEC -> USDC on AZTEC/USDC pool, all wAZTEC from swap 4 (filled at runtime)
const SWAP_DEFS: SwapDef[] = [
    { inKey: 'USDC',   outKey: 'wETH',   pool: 'wETH/USDC',   amountIn: usdc(10_000), amountInDesc: '10,000 USDC' },
    { inKey: 'USDC',   outKey: 'wZEC',   pool: 'wZEC/USDC',   amountIn: usdc(15_000), amountInDesc: '15,000 USDC' },
    { inKey: 'wETH',   outKey: 'USDC',   pool: 'wETH/USDC',   amountIn: 0n,           amountInDesc: 'all wETH'    }, // filled at runtime
    { inKey: 'USDC',   outKey: 'wAZTEC', pool: 'wAZTEC/USDC', amountIn: usdc(20_000), amountInDesc: '20,000 USDC' },
    { inKey: 'wZEC',   outKey: 'USDC',   pool: 'wZEC/USDC',   amountIn: 0n,           amountInDesc: 'all wZEC'    }, // filled at runtime
    { inKey: 'wAZTEC', outKey: 'USDC',   pool: 'wAZTEC/USDC', amountIn: 0n,           amountInDesc: 'all wAZTEC'  }, // filled at runtime
];

async function demoData() {
    console.log('=== Demo Data: Swap History for 3rd Test Account ===\n');

    // --- Load deployment info ---
    const deployPath = join(process.cwd(), 'deployment.json');
    const infra: DeployedInfra = JSON.parse(await readFile(deployPath, 'utf-8'));
    console.log('Loaded deployment.json');

    // --- Connect to node ---
    const node: AztecNode = createAztecNodeClient(AZTEC_NODE_URL);
    console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

    // --- Register all 3 test accounts ---
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
    const accounts = await getInitialTestAccountsData();
    const addresses: AztecAddress[] = [];
    for (const account of accounts) {
        const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
        addresses.push(manager.address);
    }
    const admin = addresses[0];
    const demoUser = addresses[2];
    console.log(`Admin: ${admin}`);
    console.log(`Demo user (account[2]): ${demoUser}\n`);

    // --- Register and attach to deployed contracts ---
    const { AztecAddress: AztecAddr } = await import('@aztec/aztec.js/addresses');

    // Register all contract instances on the PXE (fresh wallet doesn't know about them)
    console.log('--- Registering deployed contracts on PXE ---');
    const allAddresses = [
        infra.tokens.USDC, infra.tokens.wETH, infra.tokens.wZEC, infra.tokens.wAZTEC,
        infra.pools['wETH/USDC'].lp, infra.pools['wZEC/USDC'].lp, infra.pools['wAZTEC/USDC'].lp,
    ];
    for (const addr of allAddresses) {
        const instance = await node.getContract(AztecAddr.fromString(addr));
        if (instance) await wallet.registerContract(instance, TokenContractArtifact);
    }
    const ammAddresses = [
        infra.pools['wETH/USDC'].amm, infra.pools['wZEC/USDC'].amm, infra.pools['wAZTEC/USDC'].amm,
    ];
    for (const addr of ammAddresses) {
        const instance = await node.getContract(AztecAddr.fromString(addr));
        if (instance) await wallet.registerContract(instance, AMMContractArtifact);
    }
    {
        const instance = await node.getContract(AztecAddr.fromString(infra.priceFeed));
        if (instance) await wallet.registerContract(instance, PriceFeedContractArtifact);
    }
    console.log('  All contracts registered\n');

    const usdc_token = await TokenContract.at(AztecAddr.fromString(infra.tokens.USDC), wallet);
    const weth = await TokenContract.at(AztecAddr.fromString(infra.tokens.wETH), wallet);
    const wzec = await TokenContract.at(AztecAddr.fromString(infra.tokens.wZEC), wallet);
    const waztec = await TokenContract.at(AztecAddr.fromString(infra.tokens.wAZTEC), wallet);
    const priceFeed = await PriceFeedContract.at(AztecAddr.fromString(infra.priceFeed), wallet);

    const tokenMap: Record<TokenKey, typeof usdc_token> = {
        USDC: usdc_token,
        wETH: weth,
        wZEC: wzec,
        wAZTEC: waztec,
    };

    const ammEthUsdc = await AMMContract.at(AztecAddr.fromString(infra.pools['wETH/USDC'].amm), wallet);
    const ammZecUsdc = await AMMContract.at(AztecAddr.fromString(infra.pools['wZEC/USDC'].amm), wallet);
    const ammAztecUsdc = await AMMContract.at(AztecAddr.fromString(infra.pools['wAZTEC/USDC'].amm), wallet);

    const poolMap: Record<PoolKey, typeof ammEthUsdc> = {
        'wETH/USDC': ammEthUsdc,
        'wZEC/USDC': ammZecUsdc,
        'wAZTEC/USDC': ammAztecUsdc,
    };

    // --- Deploy the 3rd test account on-chain ---
    console.log('--- Deploying demo user account on-chain ---');
    const demoAccountData = accounts[2];
    const { SchnorrAccountContract } = await import('@aztec/accounts/schnorr');
    const { AccountManager } = await import('@aztec/aztec.js/wallet');
    const contract = new SchnorrAccountContract(demoAccountData.signingKey);
    const accountManager = await AccountManager.create(wallet, demoAccountData.secret, contract, demoAccountData.salt);

    // Check if already deployed
    const metadata = await wallet.getContractMetadata(accountManager.address);
    if (metadata.isContractInitialized) {
        console.log(`  Demo account already deployed at ${accountManager.address}\n`);
    } else {
        const deployMethod = await accountManager.getDeployMethod();
        await deployMethod.send({ from: admin, skipClassPublication: true, skipInstancePublication: true }).wait();
        console.log(`  Demo account deployed at ${accountManager.address}\n`);
    }

    // --- Mint 100,000 USDC to demo user (privately) ---
    console.log('--- Minting 100,000 USDC to demo user ---');
    const mintAmount = usdc(100_000);
    await usdc_token.methods.mint_to_private(demoUser, mintAmount).send({ from: admin }).wait();
    console.log(`  Minted ${mintAmount} USDC (100,000 with 6 decimals)\n`);

    // --- Read actual on-chain pool reserves ---
    // We read from chain rather than computing from deployment prices, because a
    // previous (possibly partial) run may have altered pool balances.
    console.log('--- Reading on-chain pool reserves ---');
    async function readReserves(token0: typeof weth, token1: typeof usdc_token, amm: typeof ammEthUsdc) {
        const r0 = BigInt(await token0.methods.balance_of_public(amm.address).simulate({ from: admin }));
        const r1 = BigInt(await token1.methods.balance_of_public(amm.address).simulate({ from: admin }));
        return { reserve0: r0, reserve1: r1 };
    }
    const ethReserves = await readReserves(weth, usdc_token, ammEthUsdc);
    const zecReserves = await readReserves(wzec, usdc_token, ammZecUsdc);
    const aztecReserves = await readReserves(waztec, usdc_token, ammAztecUsdc);
    console.log(`  wETH/USDC:   r0=${ethReserves.reserve0}, r1=${ethReserves.reserve1}`);
    console.log(`  wZEC/USDC:   r0=${zecReserves.reserve0}, r1=${zecReserves.reserve1}`);
    console.log(`  wAZTEC/USDC: r0=${aztecReserves.reserve0}, r1=${aztecReserves.reserve1}\n`);

    // All pools are token/USDC where token0=token, token1=USDC
    const poolStates: Record<PoolKey, PoolState> = {
        'wETH/USDC':   { contract: ammEthUsdc,   token0: weth,   token1: usdc_token, ...ethReserves },
        'wZEC/USDC':   { contract: ammZecUsdc,   token0: wzec,   token1: usdc_token, ...zecReserves },
        'wAZTEC/USDC': { contract: ammAztecUsdc, token0: waztec, token1: usdc_token, ...aztecReserves },
    };

    // Base oracle prices from deployment
    const baseOraclePrices: Record<TokenKey, bigint> = {
        USDC: BigInt(infra.oraclePrices.USDC),
        wETH: BigInt(infra.oraclePrices.wETH),
        wZEC: BigInt(infra.oraclePrices.wZEC),
        wAZTEC: BigInt(infra.oraclePrices.wAZTEC),
    };

    // Track amounts received from swaps (for "sell all" swaps)
    const amountsReceived: Record<string, bigint> = {};

    // --- Execute 6 swaps ---
    console.log('--- Executing 6 swaps ---');
    for (let i = 0; i < 6; i++) {
        const def = SWAP_DEFS[i];
        const mult = PRICE_MULTIPLIERS[i];

        // Update oracle prices when multipliers change
        // NOTE: We only set oracle prices, not rebalance AMM reserves.
        // The rebalancer (src/rebalance.ts) assumes same-decimal tokens and overflows
        // with mixed decimals (USDC=6, tokens=18). The oracle price is what the proof
        // circuit reads for PnL; AMM prices just determine the actual swap rate.
        if (i > 0) {
            const prevMult = PRICE_MULTIPLIERS[i - 1];
            const changed = mult.wETH !== prevMult.wETH || mult.wZEC !== prevMult.wZEC || mult.wAZTEC !== prevMult.wAZTEC;
            if (changed) {
                console.log(`\n  Updating oracle prices (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
                const newPrices: [typeof weth, bigint][] = [
                    [usdc_token, BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC))],
                    [weth,       BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH))],
                    [wzec,       BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC))],
                    [waztec,     BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC))],
                ];
                for (const [token, price] of newPrices) {
                    await priceFeed.methods.set_price(token.address.toField(), price)
                        .send({ from: admin }).wait();
                }
            }
        }

        // Resolve amountIn for "sell all" swaps
        let amountIn = def.amountIn;
        if (amountIn === 0n) {
            // "Sell all" - use the amount received from the referenced earlier swap
            if (def.inKey === 'wETH') amountIn = amountsReceived['swap1_wETH']!;
            else if (def.inKey === 'wZEC') amountIn = amountsReceived['swap2_wZEC']!;
            else if (def.inKey === 'wAZTEC') amountIn = amountsReceived['swap4_wAZTEC']!;
        }

        const tokenIn = tokenMap[def.inKey];
        const tokenOut = tokenMap[def.outKey];
        const pool = poolMap[def.pool];
        const ps = poolStates[def.pool];

        // Determine reserve ordering
        const sellingToken0 = tokenIn.address.equals(ps.token0.address);
        const reserveIn = sellingToken0 ? ps.reserve0 : ps.reserve1;
        const reserveOut = sellingToken0 ? ps.reserve1 : ps.reserve0;

        // Create authwit
        const nonce = Fr.random();
        const authwit = await wallet.createAuthWit(demoUser, {
            caller: pool.address,
            action: tokenIn.methods.transfer_to_public(demoUser, pool.address, amountIn, nonce),
        });

        // Get amount out
        const amountOut = await pool.methods
            .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
            .simulate({ from: demoUser });

        console.log(`\n  Swap ${i + 1}/6: ${def.amountInDesc} ${def.inKey} -> ${def.outKey}`);
        console.log(`    amountIn: ${amountIn}, amountOut: ${amountOut}`);

        // Execute swap
        await pool.methods
            .swap_exact_tokens_for_tokens(tokenIn.address, tokenOut.address, amountIn, amountOut, nonce)
            .with({ authWitnesses: [authwit] })
            .send({ from: demoUser })
            .wait();
        console.log(`    Swap ${i + 1} executed!`);

        const amountOutBigInt = BigInt(amountOut);

        // Track amounts for "sell all" swaps
        if (i === 0) amountsReceived['swap1_wETH'] = amountOutBigInt;
        if (i === 1) amountsReceived['swap2_wZEC'] = amountOutBigInt;
        if (i === 3) amountsReceived['swap4_wAZTEC'] = amountOutBigInt;

        // Update tracked reserves
        if (sellingToken0) {
            ps.reserve0 += amountIn;
            ps.reserve1 -= amountOutBigInt;
        } else {
            ps.reserve1 += amountIn;
            ps.reserve0 -= amountOutBigInt;
        }
    }

    console.log('\n=== Account 1 (winner) complete: 6 swaps ===\n');

    // =====================================================================
    // Phase 2: Account 2 (loser = accounts[1]) — 12 swaps that lose money
    // Buys tokens, prices crash, sells at loss. Repeats.
    // =====================================================================
    console.log('=== Phase 2: Loser account (accounts[1]) — 12 losing swaps ===\n');

    const loserUser = addresses[1];

    // --- Deploy account 2 on-chain if needed ---
    console.log('--- Deploying loser account on-chain ---');
    const loserAccountData = accounts[1];
    const loserSchnorr = new SchnorrAccountContract(loserAccountData.signingKey);
    const loserAccountManager = await AccountManager.create(
        wallet, loserAccountData.secret, loserSchnorr, loserAccountData.salt,
    );
    const loserMeta = await wallet.getContractMetadata(loserAccountManager.address);
    if (loserMeta.isContractInitialized) {
        console.log(`  Loser account already deployed at ${loserAccountManager.address}\n`);
    } else {
        const loserDeploy = await loserAccountManager.getDeployMethod();
        await loserDeploy.send({ from: admin, skipClassPublication: true, skipInstancePublication: true }).wait();
        console.log(`  Loser account deployed at ${loserAccountManager.address}\n`);
    }

    // --- Mint 100,000 USDC to loser ---
    console.log('--- Minting 100,000 USDC to loser ---');
    await usdc_token.methods.mint_to_private(loserUser, usdc(100_000)).send({ from: admin }).wait();
    console.log(`  Minted ${usdc(100_000)} USDC (100,000 with 6 decimals)\n`);

    // Price multipliers for the loser's 12 swaps.
    // Starts at account 1's final oracle state (ETH=0.95x, ZEC=1.25x, AZTEC=1.80x).
    // Buys at those prices, then prices crash, sells at loss. Repeats with a second crash.
    const LOSER_PRICE_MULTIPLIERS: { USDC: number; wETH: number; wZEC: number; wAZTEC: number }[] = [
        // Round 1 buys: at account 1's final prices
        { USDC: 1.0, wETH: 0.95, wZEC: 1.25, wAZTEC: 1.80 },  // Swap 1: buy wETH
        { USDC: 1.0, wETH: 0.95, wZEC: 1.25, wAZTEC: 1.80 },  // Swap 2: buy wZEC
        { USDC: 1.0, wETH: 0.95, wZEC: 1.25, wAZTEC: 1.80 },  // Swap 3: buy wAZTEC
        // Round 1 sells: prices crash
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 4: sell wETH at loss
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 5: sell wZEC at loss
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 6: sell wAZTEC at loss
        // Round 2 buys: "buying the dip" at crashed prices
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 7: buy wETH
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 8: buy wZEC
        { USDC: 1.0, wETH: 0.70, wZEC: 0.85, wAZTEC: 0.90 },  // Swap 9: buy wAZTEC
        // Round 2 sells: double crash
        { USDC: 1.0, wETH: 0.50, wZEC: 0.60, wAZTEC: 0.40 },  // Swap 10: sell wETH at bigger loss
        { USDC: 1.0, wETH: 0.50, wZEC: 0.60, wAZTEC: 0.40 },  // Swap 11: sell wZEC at bigger loss
        { USDC: 1.0, wETH: 0.50, wZEC: 0.60, wAZTEC: 0.40 },  // Swap 12: sell wAZTEC at bigger loss
    ];

    const LOSER_SWAP_DEFS: SwapDef[] = [
        // Round 1: buy tokens
        { inKey: 'USDC',   outKey: 'wETH',   pool: 'wETH/USDC',   amountIn: usdc(8_000),  amountInDesc: '8,000 USDC'  },
        { inKey: 'USDC',   outKey: 'wZEC',   pool: 'wZEC/USDC',   amountIn: usdc(10_000), amountInDesc: '10,000 USDC' },
        { inKey: 'USDC',   outKey: 'wAZTEC', pool: 'wAZTEC/USDC', amountIn: usdc(12_000), amountInDesc: '12,000 USDC' },
        // Round 1: sell everything at loss
        { inKey: 'wETH',   outKey: 'USDC',   pool: 'wETH/USDC',   amountIn: 0n,           amountInDesc: 'all wETH'    },
        { inKey: 'wZEC',   outKey: 'USDC',   pool: 'wZEC/USDC',   amountIn: 0n,           amountInDesc: 'all wZEC'    },
        { inKey: 'wAZTEC', outKey: 'USDC',   pool: 'wAZTEC/USDC', amountIn: 0n,           amountInDesc: 'all wAZTEC'  },
        // Round 2: buy the dip
        { inKey: 'USDC',   outKey: 'wETH',   pool: 'wETH/USDC',   amountIn: usdc(6_000),  amountInDesc: '6,000 USDC'  },
        { inKey: 'USDC',   outKey: 'wZEC',   pool: 'wZEC/USDC',   amountIn: usdc(8_000),  amountInDesc: '8,000 USDC'  },
        { inKey: 'USDC',   outKey: 'wAZTEC', pool: 'wAZTEC/USDC', amountIn: usdc(5_000),  amountInDesc: '5,000 USDC'  },
        // Round 2: sell everything at bigger loss
        { inKey: 'wETH',   outKey: 'USDC',   pool: 'wETH/USDC',   amountIn: 0n,           amountInDesc: 'all wETH'    },
        { inKey: 'wZEC',   outKey: 'USDC',   pool: 'wZEC/USDC',   amountIn: 0n,           amountInDesc: 'all wZEC'    },
        { inKey: 'wAZTEC', outKey: 'USDC',   pool: 'wAZTEC/USDC', amountIn: 0n,           amountInDesc: 'all wAZTEC'  },
    ];

    // Track token balances for "sell all" swaps
    const loserHoldings: Record<string, bigint> = {};

    console.log('--- Executing 12 swaps for loser account ---');
    for (let i = 0; i < 12; i++) {
        const def = LOSER_SWAP_DEFS[i];
        const mult = LOSER_PRICE_MULTIPLIERS[i];

        // Update oracle prices when multipliers change
        if (i > 0) {
            const prevMult = LOSER_PRICE_MULTIPLIERS[i - 1];
            const changed = mult.wETH !== prevMult.wETH || mult.wZEC !== prevMult.wZEC || mult.wAZTEC !== prevMult.wAZTEC;
            if (changed) {
                console.log(`\n  Updating oracle prices (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
                const newPrices: [typeof weth, bigint][] = [
                    [usdc_token, BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC))],
                    [weth,       BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH))],
                    [wzec,       BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC))],
                    [waztec,     BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC))],
                ];
                for (const [token, price] of newPrices) {
                    await priceFeed.methods.set_price(token.address.toField(), price)
                        .send({ from: admin }).wait();
                }
            }
        }

        // Resolve amountIn for "sell all" swaps
        let amountIn = def.amountIn;
        if (amountIn === 0n) {
            amountIn = loserHoldings[def.inKey]!;
            if (!amountIn) throw new Error(`No tracked holdings for ${def.inKey} at swap ${i + 1}`);
        }

        const tokenIn = tokenMap[def.inKey];
        const tokenOut = tokenMap[def.outKey];
        const pool = poolMap[def.pool];
        const ps = poolStates[def.pool];

        const sellingToken0 = tokenIn.address.equals(ps.token0.address);
        const reserveIn = sellingToken0 ? ps.reserve0 : ps.reserve1;
        const reserveOut = sellingToken0 ? ps.reserve1 : ps.reserve0;

        const nonce = Fr.random();
        const authwit = await wallet.createAuthWit(loserUser, {
            caller: pool.address,
            action: tokenIn.methods.transfer_to_public(loserUser, pool.address, amountIn, nonce),
        });

        const amountOut = await pool.methods
            .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
            .simulate({ from: loserUser });

        console.log(`\n  Swap ${i + 1}/12: ${def.amountInDesc} ${def.inKey} -> ${def.outKey}`);
        console.log(`    amountIn: ${amountIn}, amountOut: ${amountOut}`);

        await pool.methods
            .swap_exact_tokens_for_tokens(tokenIn.address, tokenOut.address, amountIn, amountOut, nonce)
            .with({ authWitnesses: [authwit] })
            .send({ from: loserUser })
            .wait();
        console.log(`    Swap ${i + 1} executed!`);

        const amountOutBigInt = BigInt(amountOut);

        // Track holdings: accumulate on buy, clear on sell
        if (def.inKey === 'USDC') {
            loserHoldings[def.outKey] = (loserHoldings[def.outKey] || 0n) + amountOutBigInt;
        } else {
            delete loserHoldings[def.inKey];
        }

        // Update tracked reserves
        if (sellingToken0) {
            ps.reserve0 += amountIn;
            ps.reserve1 -= amountOutBigInt;
        } else {
            ps.reserve1 += amountIn;
            ps.reserve0 -= amountOutBigInt;
        }
    }

    // --- Reset oracle prices to base (1.0x) values ---
    console.log('\n--- Resetting oracle prices to base values ---');
    const resetPrices: [typeof weth, bigint, string][] = [
        [usdc_token, baseOraclePrices.USDC, 'USDC'],
        [weth,       baseOraclePrices.wETH, 'wETH'],
        [wzec,       baseOraclePrices.wZEC, 'wZEC'],
        [waztec,     baseOraclePrices.wAZTEC, 'wAZTEC'],
    ];
    for (const [token, price, name] of resetPrices) {
        await priceFeed.methods.set_price(token.address.toField(), price)
            .send({ from: admin }).wait();
        console.log(`  ${name} = ${price}`);
    }

    console.log('\n=== Demo data complete! ===');
    console.log(`Winner (accounts[2]): ${demoUser} — 6 swaps, net profit`);
    console.log(`Loser  (accounts[1]): ${loserUser} — 12 swaps, net loss`);
}

demoData().catch((err) => {
    console.error('Demo data failed:', err);
    process.exit(1);
});
