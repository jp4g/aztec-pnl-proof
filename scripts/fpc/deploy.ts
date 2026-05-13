import { deployAztecFPC } from '@jp4g/fpc-deployer';
import { getDeployerCredentials, getL2Config, syncFrontendFPCAddress, upsertEnvVar } from './utils';

async function deploy() {
    const result = await deployAztecFPC({
        ...getL2Config(),
        ...getDeployerCredentials(),
    });

    upsertEnvVar('SPONSORED_FPC_ADDRESS', result.fpcAddress);
    syncFrontendFPCAddress(result.fpcAddress);

    console.log(`\nSponsoredFPC address: ${result.fpcAddress}`);
}

deploy().catch((err) => {
    console.error('Deploy failed:', err);
    process.exit(1);
});
