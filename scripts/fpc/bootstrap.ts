import { bootstrapAztecFPC, deployAccountAztecFPC } from '@jp4g/fpc-deployer';
import { getDeployerCredentials, getL1Config, getL2Config, upsertEnvVar } from './utils';

async function bootstrap() {
    const result = await bootstrapAztecFPC({
        ...getL2Config(),
        ...getL1Config(),
    });

    upsertEnvVar('FPC_DEPLOYER_SECRET_KEY', result.secretKey);
    upsertEnvVar('FPC_DEPLOYER_SIGNING_KEY', result.signingKey);
    upsertEnvVar('FPC_DEPLOYER_SALT', result.salt);

    console.log(`\nDeployer address: ${result.address}`);

    await deployAccountAztecFPC({
        ...getL2Config(),
        ...getDeployerCredentials(),
        claim: result.claim,
    });

    console.log('Account deployed.');
}

bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
