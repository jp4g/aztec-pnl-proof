import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import type { AztecNode } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/foundation/curves/bn254';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getCanonicalFeeJuice } from '@aztec/protocol-contracts/fee-juice';
import type { EmbeddedWallet } from '@aztec/wallets/embedded';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const LOCAL_ENV_PATH = resolve(process.cwd(), '.env.local');

export function isLocalNodeUrl(url: string) {
    try {
        const hostname = new URL(url).hostname;
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
        return false;
    }
}

function upsertLocalEnvVar(key: string, value: string) {
    let content = '';
    try { content = readFileSync(LOCAL_ENV_PATH, 'utf-8'); } catch {}
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content += `\n${key}=${value}`;
    }
    writeFileSync(LOCAL_ENV_PATH, content.trim() + '\n');
}

async function getRegisteredFPC(node: AztecNode, wallet: EmbeddedWallet, address: AztecAddress) {
    const fpcInstance = await node.getContract(address);
    if (!fpcInstance) return undefined;
    await wallet.registerContract(fpcInstance, SponsoredFPCContract.artifact);
    return address;
}

async function getLocalAccountAddress(wallet: EmbeddedWallet) {
    const [account] = await getInitialTestAccountsData();
    const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
    return manager.address;
}

async function getFeeJuiceBalance(wallet: EmbeddedWallet, owner: AztecAddress, from: AztecAddress) {
    const feeJuiceInstance = await getCanonicalFeeJuice();
    await wallet.registerContract(feeJuiceInstance.instance as any, FeeJuiceContract.artifact);
    const feeJuice = await FeeJuiceContract.at(feeJuiceInstance.address as any, wallet);
    const balance = await feeJuice.methods.balance_of_public(owner).simulate({ from });
    return BigInt(balance.result ?? balance);
}

export async function ensureLocalSponsoredFPC(input: {
    node: AztecNode;
    wallet: EmbeddedWallet;
}) {
    const canonical = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
        salt: new Fr(SPONSORED_FPC_SALT),
    });
    const canonicalAddress = canonical.address;
    const existing = await getRegisteredFPC(input.node, input.wallet, canonicalAddress);
    if (existing) {
        upsertLocalEnvVar('LOCAL_SPONSORED_FPC_ADDRESS', canonicalAddress.toString());
        console.log(`  Local SponsoredFPC registered at: ${canonicalAddress}`);
        return canonicalAddress;
    }

    const deployer = await getLocalAccountAddress(input.wallet);
    const deployRequest = SponsoredFPCContract.deploy(input.wallet);
    const deployOptions = {
        from: deployer,
        contractAddressSalt: new Fr(SPONSORED_FPC_SALT),
        universalDeploy: true,
        wait: { timeout: 600, returnReceipt: true },
    } as const;
    await deployRequest.simulate(deployOptions);
    const deployed = await deployRequest.send(deployOptions);

    const fpcAddress = deployed.receipt.contract.address;
    await input.wallet.registerContract(deployed.receipt.instance, SponsoredFPCContract.artifact);
    const balance = await getFeeJuiceBalance(input.wallet, fpcAddress, deployer);
    if (balance === 0n) {
        throw new Error(
            'Local SponsoredFPC deployed but has no fee juice. Restart localhost with `SPONSORED_FPC=true aztec start --local-network`.',
        );
    }

    upsertLocalEnvVar('LOCAL_SPONSORED_FPC_ADDRESS', fpcAddress.toString());
    console.log(`  Local SponsoredFPC deployed at: ${fpcAddress}`);
    console.log(`  Local SponsoredFPC fee juice: ${balance}`);
    return fpcAddress;
}
