import { Fr } from '@aztec/aztec.js/fields';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { createLogger } from '@aztec/foundation/log';
import { join } from 'path';
import { createWalletWithoutFPC, loadFPCDeployerAccount, upsertEnvVar } from './utils';

async function deploy() {
    const logger = createLogger('fpc:deploy');

    const { wallet } = await createWalletWithoutFPC();
    const account = await loadFPCDeployerAccount(wallet);
    const [{ item: from }] = await wallet.getAccounts();

    logger.info(`Deploying SponsoredFPC from ${account.address}...`);

    const deployRequest = SponsoredFPCContract.deploy(wallet);
    await deployRequest.simulate({ from });

    const deployed = await deployRequest.send({
        from,
        contractAddressSalt: new Fr(SPONSORED_FPC_SALT),
        universalDeploy: true,
    });

    const fpcAddress = deployed.contract.address.toString();
    logger.info(`SponsoredFPC deployed at: ${fpcAddress}`);

    // Save to root .env
    upsertEnvVar('SPONSORED_FPC_ADDRESS', fpcAddress);

    // Save to frontend env files
    const frontendEnvProd = join(process.cwd(), 'packages', 'frontend', '.env.production');
    const frontendEnvDev = join(process.cwd(), 'packages', 'frontend', '.env.development');
    upsertEnvVar('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS', fpcAddress, frontendEnvProd);
    upsertEnvVar('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS', fpcAddress, frontendEnvDev);

    logger.info(`Address saved to .env and frontend env files`);
    console.log(`\nSponsoredFPC address: ${fpcAddress}`);
}

deploy().catch((err) => {
    console.error('Deploy failed:', err);
    process.exit(1);
});
