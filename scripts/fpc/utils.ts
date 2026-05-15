import 'dotenv/config';
import type { DeployerCredentials, L1Config, L2Config } from '@jp4g/fpc-deployer';
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export function getL2Config(): L2Config {
    const l2Url = process.env.L2_NODE_URL ?? process.env.AZTEC_NODE_URL;
    if (!l2Url) throw new Error('L2_NODE_URL or AZTEC_NODE_URL is required in .env');
    return { l2Url };
}

export function getL1Config(): L1Config {
    const l1RpcUrl = process.env.L1_RPC_URL;
    const l1ChainId = process.env.L1_CHAIN_ID;
    const l1PrivateKey = process.env.L1_PRIVATE_KEY;
    if (!l1RpcUrl) throw new Error('L1_RPC_URL is required in .env');
    if (!l1ChainId) throw new Error('L1_CHAIN_ID is required in .env');
    if (!l1PrivateKey) throw new Error('L1_PRIVATE_KEY is required in .env');

    return {
        l1RpcUrl,
        l1ChainId: parseInt(l1ChainId, 10),
        l1PrivateKey,
    };
}

export function getDeployerCredentials(): DeployerCredentials {
    const secretKey = process.env.FPC_DEPLOYER_SECRET_KEY;
    const signingKey = process.env.FPC_DEPLOYER_SIGNING_KEY;
    const salt = process.env.FPC_DEPLOYER_SALT;
    if (!secretKey || !signingKey || !salt) {
        throw new Error(
            'FPC_DEPLOYER_SECRET_KEY, FPC_DEPLOYER_SIGNING_KEY, and FPC_DEPLOYER_SALT are required. Run `yarn fpc:bootstrap` first.',
        );
    }
    return { secretKey, signingKey, salt };
}

export function getFPCAddress(): string {
    const fpcAddress = process.env.SPONSORED_FPC_ADDRESS;
    if (!fpcAddress) {
        throw new Error('SPONSORED_FPC_ADDRESS is required in .env. Run `yarn fpc:deploy` first.');
    }
    return fpcAddress;
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
    process.env[key] = value;
}

export function syncFrontendFPCAddress(fpcAddress: string) {
    const frontendEnvProd = join(process.cwd(), 'packages', 'frontend', '.env.production');
    const frontendEnvDev = join(process.cwd(), 'packages', 'frontend', '.env.development');
    upsertEnvVar('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS', fpcAddress, frontendEnvProd);
    upsertEnvVar('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS', fpcAddress, frontendEnvDev);
}
