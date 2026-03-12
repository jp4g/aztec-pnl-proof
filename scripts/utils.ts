import 'dotenv/config';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Fr } from '@aztec/foundation/curves/bn254';
import { readFile } from 'fs/promises';
import { join } from 'path';

export interface AccountInfo {
    address: string;
    secretKey: string;
    signingKey: string;
    salt: string;
}

export interface DeployedInfra {
    admin: string;
    adminAccount?: AccountInfo;
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
    demoAccounts?: AccountInfo[];
}

export interface WalletSetup {
    node: AztecNode;
    wallet: EmbeddedWallet;
    isDevnet: boolean;
    fpcAddress: AztecAddress | undefined;
}

/**
 * Connect to the Aztec node, detect devnet vs sandbox, create an ephemeral wallet,
 * and register SponsoredFPC on devnet.
 */
export async function initializeWallet(nodeUrl = 'http://localhost:8080'): Promise<WalletSetup> {
    const node: AztecNode = createAztecNodeClient(nodeUrl);
    console.log(`Connected to Aztec node at "${nodeUrl}"`);

    const nodeInfo = await node.getNodeInfo();
    const isDevnet = nodeInfo.l1ChainId === 11155111;
    console.log(`  Chain ID: ${nodeInfo.l1ChainId}, isDevnet: ${isDevnet}`);

    const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: isDevnet } });

    let fpcAddress: AztecAddress | undefined;
    if (isDevnet) {
        fpcAddress = await registerSponsoredFPC(wallet);
    }

    return { node, wallet, isDevnet, fpcAddress };
}

/**
 * Register the SponsoredFPC contract on the wallet. Returns its address.
 */
export async function registerSponsoredFPC(wallet: EmbeddedWallet): Promise<AztecAddress> {
    const fpcInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
        salt: new Fr(SPONSORED_FPC_SALT),
    });
    await wallet.registerContract(fpcInstance, SponsoredFPCContract.artifact);
    console.log(`  SponsoredFPC registered at: ${fpcInstance.address}`);
    return fpcInstance.address;
}

/**
 * Create a sendOpts function that adds sponsored fee payment on devnet.
 */
export function makeSendOpts(isDevnet: boolean, fpcAddress: AztecAddress | undefined) {
    return (from: AztecAddress) =>
        isDevnet && fpcAddress
            ? { from, fee: { paymentMethod: new SponsoredFeePaymentMethod(fpcAddress) } }
            : { from };
}

/**
 * Register sandbox test accounts on the wallet. Returns their addresses.
 */
export async function registerSandboxAccounts(wallet: EmbeddedWallet): Promise<{ addresses: AztecAddress[]; accounts: AccountInfo[] }> {
    const testData = await getInitialTestAccountsData();
    const addresses: AztecAddress[] = [];
    const accounts: AccountInfo[] = [];
    for (const account of testData) {
        const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
        addresses.push(manager.address);
        accounts.push({
            address: manager.address.toString(),
            secretKey: account.secret.toString(),
            signingKey: account.signingKey.toString(),
            salt: account.salt.toString(),
        });
    }
    return { addresses, accounts };
}

/**
 * Load and parse deployment.json from the project root.
 */
export async function loadDeployment(): Promise<DeployedInfra> {
    const deployPath = join(process.cwd(), 'deployment.json');
    return JSON.parse(await readFile(deployPath, 'utf-8'));
}
