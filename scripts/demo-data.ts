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
 * Usage:
 *   yarn demo-data                    # full run (default)
 *   yarn demo-data --resume loser:7   # skip winner, resume loser at swap 7
 *   yarn demo-data --resume winner:4  # resume winner at swap 4
 */

import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fq, Fr } from '@aztec/aztec.js/fields';
import { PriceFeedContract, PriceFeedContractArtifact } from '@privpnl/contracts/PriceFeed';
import { TokenContract, TokenContractArtifact } from '@privpnl/contracts/Token';
import { AMMContract, AMMContractArtifact } from '@privpnl/contracts/AMM';
import { rebalancePools, type PoolState } from '@privpnl/proof/rebalance';
import { USDC_DECIMALS, TOKEN_DECIMALS } from '@privpnl/proof/constants';
import {
    type DeployedInfra,
    initializeWallet, makeSendOpts, registerSandboxAccounts, loadDeployment,
} from './utils';

const { AZTEC_NODE_URL = 'http://localhost:8080' } = process.env;

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

async function getPrivateBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
    const { result: raw } = await token.methods.balance_of_private(owner).simulate({ from: owner });
    return typeof raw === 'bigint' ? raw : BigInt(raw.toString());
}

async function demoData() {
    // --- Parse --resume arg ---
    let resumePhase: 'winner' | 'loser' | null = null;
    let resumeSwap = 0; // 0-indexed
    const resumeArgIdx = process.argv.indexOf('--resume');
    if (resumeArgIdx !== -1) {
        const resumeArg = process.argv[resumeArgIdx + 1];
        if (!resumeArg) throw new Error('--resume requires a value like winner:4 or loser:7');
        const [phase, num] = resumeArg.split(':');
        if (phase !== 'winner' && phase !== 'loser') throw new Error('--resume must be winner:N or loser:N');
        resumePhase = phase;
        resumeSwap = parseInt(num, 10) - 1; // convert to 0-indexed
        if (isNaN(resumeSwap) || resumeSwap < 0) throw new Error('--resume swap number must be >= 1');
        if (phase === 'winner' && resumeSwap >= 6) throw new Error('--resume winner:N — N must be 1-6');
        if (phase === 'loser' && resumeSwap >= 12) throw new Error('--resume loser:N — N must be 1-12');
        console.log(`=== RESUME MODE: ${phase} phase, starting at swap ${resumeSwap + 1} ===\n`);
    }

    console.log('=== Demo Data: Swap History for 3rd Test Account ===\n');

    // --- Load deployment info ---
    const infra = await loadDeployment();
    console.log('Loaded deployment.json');

    // --- Connect to node ---
    const { node, wallet, isDevnet, fpcAddress } = await initializeWallet(AZTEC_NODE_URL);
    const sendOpts = makeSendOpts(isDevnet, fpcAddress);

    const addresses: AztecAddress[] = [];

    if (isDevnet) {
        // Read admin + demo accounts from deployment.json
        if (!infra.adminAccount) {
            throw new Error('deployment.json missing adminAccount — run deploy.ts on devnet first');
        }
        if (!infra.demoAccounts || infra.demoAccounts.length < 2) {
            throw new Error('deployment.json missing demoAccounts — run deploy.ts on devnet first');
        }

        // Register admin from deployment.json keys
        const adminManager = await wallet.createSchnorrAccount(
            Fr.fromString(infra.adminAccount.secretKey),
            Fr.fromString(infra.adminAccount.salt),
            Fq.fromString(infra.adminAccount.signingKey),
        );
        addresses.push(adminManager.address);

        // Register demo accounts from deployment.json keys
        for (const demo of infra.demoAccounts) {
            const manager = await wallet.createSchnorrAccount(
                Fr.fromString(demo.secretKey),
                Fr.fromString(demo.salt),
                Fq.fromString(demo.signingKey),
            );
            addresses.push(manager.address);
        }

        // Force PXE to discover signing key notes
        const pxeDebug = (wallet.pxe as any).debug;
        for (let i = 0; i < addresses.length; i++) {
            const notes = await pxeDebug.getNotes({
                contractAddress: addresses[i],
                scopes: [addresses[i]],
            });
            console.log(`  Account ${i} notes after sync: ${notes.length}`);
        }
    } else {
        // Sandbox: use pre-deployed test accounts
        const { addresses: sbAddresses } = await registerSandboxAccounts(wallet);
        addresses.push(...sbAddresses);
    }

    const admin = addresses[0];
    // On sandbox: demo accounts are addresses[2] and addresses[1]
    // On devnet: demo accounts are addresses[1] and addresses[2] (from deployment.json)
    const demoUser = isDevnet ? addresses[1] : addresses[2];
    console.log(`Admin: ${admin}`);
    console.log(`Demo user (winner): ${demoUser}\n`);

    // --- Register and attach to deployed contracts ---
    // Register all contract instances on the PXE (fresh wallet doesn't know about them)
    console.log('--- Registering deployed contracts on PXE ---');
    const allAddresses = [
        infra.tokens.USDC, infra.tokens.wETH, infra.tokens.wZEC, infra.tokens.wAZTEC,
        infra.pools['wETH/USDC'].lp, infra.pools['wZEC/USDC'].lp, infra.pools['wAZTEC/USDC'].lp,
    ];
    for (const addr of allAddresses) {
        const instance = await node.getContract(AztecAddress.fromString(addr));
        if (instance) await wallet.registerContract(instance, TokenContractArtifact);
    }
    const ammAddresses = [
        infra.pools['wETH/USDC'].amm, infra.pools['wZEC/USDC'].amm, infra.pools['wAZTEC/USDC'].amm,
    ];
    for (const addr of ammAddresses) {
        const instance = await node.getContract(AztecAddress.fromString(addr));
        if (instance) await wallet.registerContract(instance, AMMContractArtifact);
    }
    {
        const instance = await node.getContract(AztecAddress.fromString(infra.priceFeed));
        if (instance) await wallet.registerContract(instance, PriceFeedContractArtifact);
    }
    console.log('  All contracts registered\n');

    const usdc_token = await TokenContract.at(AztecAddress.fromString(infra.tokens.USDC), wallet);
    const weth = await TokenContract.at(AztecAddress.fromString(infra.tokens.wETH), wallet);
    const wzec = await TokenContract.at(AztecAddress.fromString(infra.tokens.wZEC), wallet);
    const waztec = await TokenContract.at(AztecAddress.fromString(infra.tokens.wAZTEC), wallet);
    const priceFeed = await PriceFeedContract.at(AztecAddress.fromString(infra.priceFeed), wallet);

    const tokenMap: Record<TokenKey, typeof usdc_token> = {
        USDC: usdc_token,
        wETH: weth,
        wZEC: wzec,
        wAZTEC: waztec,
    };

    const ammEthUsdc = await AMMContract.at(AztecAddress.fromString(infra.pools['wETH/USDC'].amm), wallet);
    const ammZecUsdc = await AMMContract.at(AztecAddress.fromString(infra.pools['wZEC/USDC'].amm), wallet);
    const ammAztecUsdc = await AMMContract.at(AztecAddress.fromString(infra.pools['wAZTEC/USDC'].amm), wallet);

    const poolMap: Record<PoolKey, typeof ammEthUsdc> = {
        'wETH/USDC': ammEthUsdc,
        'wZEC/USDC': ammZecUsdc,
        'wAZTEC/USDC': ammAztecUsdc,
    };

    // --- Deploy the demo user account on-chain (sandbox only, devnet already deployed) ---
    if (resumePhase) {
        console.log('  [resume] Skipping demo user account deployment & minting\n');
    } else if (!isDevnet) {
        console.log('--- Deploying demo user account on-chain ---');
        const accounts = await getInitialTestAccountsData();
        const demoAccountData = accounts[2];
        const { SchnorrAccountContract } = await import('@aztec/accounts/schnorr');
        const { AccountManager } = await import('@aztec/aztec.js/wallet');
        const contract = new SchnorrAccountContract(demoAccountData.signingKey);
        const accountManager = await AccountManager.create(wallet, demoAccountData.secret, contract, demoAccountData.salt);

        const metadata = await wallet.getContractMetadata(accountManager.address);
        if (metadata.isContractInitialized) {
            console.log(`  Demo account already deployed at ${accountManager.address}\n`);
        } else {
            const deployMethod = await accountManager.getDeployMethod();
            await deployMethod.send({ from: admin, skipClassPublication: true, skipInstancePublication: true });
            console.log(`  Demo account deployed at ${accountManager.address}\n`);
        }
    } else {
        console.log(`  Demo user already deployed on devnet at ${demoUser}\n`);
    }

    if (!resumePhase) {
        // --- Mint 100,000 USDC to demo user (privately) ---
        console.log('--- Minting 100,000 USDC to demo user ---');
        const mintAmount = usdc(100_000);
        await usdc_token.methods.mint_to_private(demoUser, mintAmount).send(sendOpts(admin));
        console.log(`  Minted ${mintAmount} USDC (100,000 with 6 decimals)\n`);
    }

    // --- Read actual on-chain pool reserves ---
    // We read from chain rather than computing from deployment prices, because a
    // previous (possibly partial) run may have altered pool balances.
    console.log('--- Reading on-chain pool reserves ---');
    async function readReserves(token0: typeof weth, token1: typeof usdc_token, amm: typeof ammEthUsdc) {
        const { result: r0raw } = await token0.methods.balance_of_public(amm.address).simulate({ from: admin });
        const r0 = typeof r0raw === 'bigint' ? r0raw : BigInt(r0raw.toString());
        const { result: r1raw } = await token1.methods.balance_of_public(amm.address).simulate({ from: admin });
        const r1 = typeof r1raw === 'bigint' ? r1raw : BigInt(r1raw.toString());
        return { reserve0: r0, reserve1: r1 };
    }
    const [ethReserves, zecReserves, aztecReserves] = await Promise.all([
        readReserves(weth, usdc_token, ammEthUsdc),
        readReserves(wzec, usdc_token, ammZecUsdc),
        readReserves(waztec, usdc_token, ammAztecUsdc),
    ]);
    console.log(`  wETH/USDC:   r0=${ethReserves.reserve0}, r1=${ethReserves.reserve1}`);
    console.log(`  wZEC/USDC:   r0=${zecReserves.reserve0}, r1=${zecReserves.reserve1}`);
    console.log(`  wAZTEC/USDC: r0=${aztecReserves.reserve0}, r1=${aztecReserves.reserve1}\n`);

    // All pools are token/USDC where token0=token, token1=USDC
    const poolStates: Record<PoolKey, PoolState> = {
        'wETH/USDC':   { contract: ammEthUsdc,   token0: weth,   token1: usdc_token, ...ethReserves,   decimals0: TOKEN_DECIMALS, decimals1: USDC_DECIMALS },
        'wZEC/USDC':   { contract: ammZecUsdc,   token0: wzec,   token1: usdc_token, ...zecReserves,   decimals0: TOKEN_DECIMALS, decimals1: USDC_DECIMALS },
        'wAZTEC/USDC': { contract: ammAztecUsdc, token0: waztec, token1: usdc_token, ...aztecReserves, decimals0: TOKEN_DECIMALS, decimals1: USDC_DECIMALS },
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

    // --- Execute 6 swaps (winner) ---
    const winnerStart = resumePhase === 'winner' ? resumeSwap : 0;
    const skipWinner = resumePhase === 'loser';

    if (skipWinner) {
        console.log('--- [resume] Skipping winner phase entirely ---\n');
    } else {
        // Apply price state before entering loop when resuming
        if (resumePhase === 'winner') {
            const mult = PRICE_MULTIPLIERS[resumeSwap];
            console.log(`  [resume] Applying price state for winner swap ${resumeSwap + 1} (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
            await rebalancePools({
                wallet,
                priceFeed,
                minter: admin,
                pools: Object.values(poolStates),
                tokenPrices: [
                    { token: usdc_token, price: BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC)) },
                    { token: weth,       price: BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH)) },
                    { token: wzec,       price: BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC)) },
                    { token: waztec,     price: BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC)) },
                ],
                sendOpts,
            });
        }

        console.log(`--- Executing swaps ${winnerStart + 1}-6 (winner) ---`);
    }

    for (let i = winnerStart; !skipWinner && i < 6; i++) {
        const def = SWAP_DEFS[i];
        const mult = PRICE_MULTIPLIERS[i];

        // Update oracle prices and rebalance pools when multipliers change
        if (i > winnerStart) {
            const prevMult = PRICE_MULTIPLIERS[i - 1];
            const changed = mult.wETH !== prevMult.wETH || mult.wZEC !== prevMult.wZEC || mult.wAZTEC !== prevMult.wAZTEC;
            if (changed) {
                console.log(`\n  Updating oracle prices & rebalancing (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
                await rebalancePools({
                    wallet,
                    priceFeed,
                    minter: admin,
                    pools: Object.values(poolStates),
                    tokenPrices: [
                        { token: usdc_token, price: BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC)) },
                        { token: weth,       price: BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH)) },
                        { token: wzec,       price: BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC)) },
                        { token: waztec,     price: BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC)) },
                    ],
                    sendOpts,
                });
            }
        }

        // Resolve amountIn for "sell all" swaps
        let amountIn = def.amountIn;
        if (amountIn === 0n) {
            // "Sell all" - use the amount received from the referenced earlier swap
            if (def.inKey === 'wETH') amountIn = amountsReceived['swap1_wETH'] ?? 0n;
            else if (def.inKey === 'wZEC') amountIn = amountsReceived['swap2_wZEC'] ?? 0n;
            else if (def.inKey === 'wAZTEC') amountIn = amountsReceived['swap4_wAZTEC'] ?? 0n;
            // Fallback: read private balance from chain (needed when resuming)
            if (amountIn === 0n) {
                console.log(`    [resume] Reading ${def.inKey} private balance from chain...`);
                amountIn = await getPrivateBalance(tokenMap[def.inKey], demoUser);
            }
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
        const { result: amountOut } = await pool.methods
            .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
            .simulate({ from: demoUser });

        console.log(`\n  Swap ${i + 1}/6: ${def.amountInDesc} ${def.inKey} -> ${def.outKey}`);
        console.log(`    amountIn: ${amountIn}, amountOut: ${amountOut}`);

        // Execute swap
        await pool.methods
            .swap_exact_tokens_for_tokens(tokenIn.address, tokenOut.address, amountIn, amountOut, nonce)
            .with({ authWitnesses: [authwit] })
            .send(sendOpts(demoUser))
            ;
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
    console.log('=== Phase 2: Loser account — 12 losing swaps ===\n');

    // On sandbox: loser is addresses[1], on devnet: addresses[2] (2nd demo account)
    const loserUser = isDevnet ? addresses[2] : addresses[1];

    if (resumePhase) {
        console.log('  [resume] Skipping loser account deployment & minting\n');
    } else if (!isDevnet) {
        // --- Deploy loser account on-chain (sandbox only) ---
        console.log('--- Deploying loser account on-chain ---');
        const accounts = await getInitialTestAccountsData();
        const loserAccountData = accounts[1];
        const { SchnorrAccountContract } = await import('@aztec/accounts/schnorr');
        const { AccountManager } = await import('@aztec/aztec.js/wallet');
        const loserSchnorr = new SchnorrAccountContract(loserAccountData.signingKey);
        const loserAccountManager = await AccountManager.create(
            wallet, loserAccountData.secret, loserSchnorr, loserAccountData.salt,
        );
        const loserMeta = await wallet.getContractMetadata(loserAccountManager.address);
        if (loserMeta.isContractInitialized) {
            console.log(`  Loser account already deployed at ${loserAccountManager.address}\n`);
        } else {
            const loserDeploy = await loserAccountManager.getDeployMethod();
            await loserDeploy.send({ from: admin, skipClassPublication: true, skipInstancePublication: true });
            console.log(`  Loser account deployed at ${loserAccountManager.address}\n`);
        }
    } else {
        console.log(`  Loser account already deployed on devnet at ${loserUser}\n`);
    }

    if (!resumePhase) {
        // --- Mint 100,000 USDC to loser ---
        console.log('--- Minting 100,000 USDC to loser ---');
        await usdc_token.methods.mint_to_private(loserUser, usdc(100_000)).send(sendOpts(admin));
        console.log(`  Minted ${usdc(100_000)} USDC (100,000 with 6 decimals)\n`);
    }

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

    const loserStart = resumePhase === 'loser' ? resumeSwap : 0;

    // Apply price state before entering loser loop when resuming
    if (resumePhase === 'loser') {
        const mult = LOSER_PRICE_MULTIPLIERS[resumeSwap];
        console.log(`  [resume] Applying price state for loser swap ${resumeSwap + 1} (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
        await rebalancePools({
            wallet,
            priceFeed,
            minter: admin,
            pools: Object.values(poolStates),
            tokenPrices: [
                { token: usdc_token, price: BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC)) },
                { token: weth,       price: BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH)) },
                { token: wzec,       price: BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC)) },
                { token: waztec,     price: BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC)) },
            ],
            sendOpts,
        });
    }

    console.log(`--- Executing swaps ${loserStart + 1}-12 for loser account ---`);
    for (let i = loserStart; i < 12; i++) {
        const def = LOSER_SWAP_DEFS[i];
        const mult = LOSER_PRICE_MULTIPLIERS[i];

        // Update oracle prices and rebalance pools when multipliers change
        if (i > loserStart) {
            const prevMult = LOSER_PRICE_MULTIPLIERS[i - 1];
            const changed = mult.wETH !== prevMult.wETH || mult.wZEC !== prevMult.wZEC || mult.wAZTEC !== prevMult.wAZTEC;
            if (changed) {
                console.log(`\n  Updating oracle prices & rebalancing (ETH:${mult.wETH}x, ZEC:${mult.wZEC}x, AZTEC:${mult.wAZTEC}x)`);
                await rebalancePools({
                    wallet,
                    priceFeed,
                    minter: admin,
                    pools: Object.values(poolStates),
                    tokenPrices: [
                        { token: usdc_token, price: BigInt(Math.round(Number(baseOraclePrices.USDC) * mult.USDC)) },
                        { token: weth,       price: BigInt(Math.round(Number(baseOraclePrices.wETH) * mult.wETH)) },
                        { token: wzec,       price: BigInt(Math.round(Number(baseOraclePrices.wZEC) * mult.wZEC)) },
                        { token: waztec,     price: BigInt(Math.round(Number(baseOraclePrices.wAZTEC) * mult.wAZTEC)) },
                    ],
                    sendOpts,
                });
            }
        }

        // Resolve amountIn for "sell all" swaps
        let amountIn = def.amountIn;
        if (amountIn === 0n) {
            amountIn = loserHoldings[def.inKey] ?? 0n;
            // Fallback: read private balance from chain (needed when resuming)
            if (amountIn === 0n) {
                console.log(`    [resume] Reading ${def.inKey} private balance from chain...`);
                amountIn = await getPrivateBalance(tokenMap[def.inKey], loserUser);
            }
            if (amountIn === 0n) throw new Error(`No holdings for ${def.inKey} at loser swap ${i + 1} (checked chain)`);
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

        const { result: amountOut } = await pool.methods
            .get_amount_out_for_exact_in(reserveIn, reserveOut, amountIn)
            .simulate({ from: loserUser });

        console.log(`\n  Swap ${i + 1}/12: ${def.amountInDesc} ${def.inKey} -> ${def.outKey}`);
        console.log(`    amountIn: ${amountIn}, amountOut: ${amountOut}`);

        await pool.methods
            .swap_exact_tokens_for_tokens(tokenIn.address, tokenOut.address, amountIn, amountOut, nonce)
            .with({ authWitnesses: [authwit] })
            .send(sendOpts(loserUser))
            ;
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

    // --- Reset oracle prices to base (1.0x) values and rebalance ---
    console.log('\n--- Resetting oracle prices to base values & rebalancing ---');
    await rebalancePools({
        wallet,
        priceFeed,
        minter: admin,
        pools: Object.values(poolStates),
        tokenPrices: [
            { token: usdc_token, price: baseOraclePrices.USDC },
            { token: weth,       price: baseOraclePrices.wETH },
            { token: wzec,       price: baseOraclePrices.wZEC },
            { token: waztec,     price: baseOraclePrices.wAZTEC },
        ],
        sendOpts,
    });
    console.log('  Prices reset and pools rebalanced');

    console.log('\n=== Demo data complete! ===');
    console.log(`Winner (accounts[2]): ${demoUser} — 6 swaps, net profit`);
    console.log(`Loser  (accounts[1]): ${loserUser} — 12 swaps, net loss`);
}

demoData().catch((err) => {
    console.error('Demo data failed:', err);
    process.exit(1);
});
