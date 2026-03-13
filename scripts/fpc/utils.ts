import 'dotenv/config';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { createEthereumChain } from '@aztec/ethereum/chain';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { Fr } from '@aztec/aztec.js/fields';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export function getNode() {
    const url = process.env.AZTEC_NODE_URL;
    if (!url) throw new Error('AZTEC_NODE_URL is required in .env');
    return createAztecNodeClient(url);
}

export function createL1Client() {
    const rpcUrl = process.env.L1_RPC_URL;
    const chainId = process.env.L1_CHAIN_ID;
    const privateKey = process.env.L1_PRIVATE_KEY;
    if (!rpcUrl) throw new Error('L1_RPC_URL is required in .env');
    if (!chainId) throw new Error('L1_CHAIN_ID is required in .env');
    if (!privateKey) throw new Error('L1_PRIVATE_KEY is required in .env');

    const chain = createEthereumChain([rpcUrl], parseInt(chainId, 10));
    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return createExtendedL1Client(chain.rpcUrls, key, chain.chainInfo);
}

export function createFreshL1Client() {
    return createL1Client();
}

export async function createWalletWithoutFPC() {
    const node = getNode();
    const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
    const wallet = await EmbeddedWallet.create(node, {
        ephemeral: true,
        pxeConfig: { proverEnabled: true },
    });
    return { wallet, node };
}

export async function loadFPCDeployerAccount(wallet: any) {
    const secretKey = process.env.FPC_DEPLOYER_SECRET_KEY;
    const signingKey = process.env.FPC_DEPLOYER_SIGNING_KEY;
    const salt = process.env.FPC_DEPLOYER_SALT;
    if (!secretKey || !signingKey || !salt) {
        throw new Error(
            'FPC_DEPLOYER_SECRET_KEY, FPC_DEPLOYER_SIGNING_KEY, and FPC_DEPLOYER_SALT are required. Run `yarn fpc:bootstrap` first.',
        );
    }
    const account = await wallet.createSchnorrAccount(
        Fr.fromHexString(secretKey),
        Fr.fromHexString(salt),
        GrumpkinScalar.fromString(signingKey),
    );
    return account;
}

export function getFPCAddress(): AztecAddress {
    const addr = process.env.SPONSORED_FPC_ADDRESS;
    if (!addr) {
        throw new Error('SPONSORED_FPC_ADDRESS is required in .env. Run `yarn fpc:deploy` first.');
    }
    return AztecAddress.fromString(addr);
}

export function upsertEnvVar(key: string, value: string, envPath?: string) {
    const path = envPath ?? resolve(process.cwd(), '.env');
    let content = '';
    try { content = readFileSync(path, 'utf-8'); } catch {}
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content += `\n${key}=${value}`;
    }
    writeFileSync(path, content.trim() + '\n');
}
