import { statusAztecFPC } from '@jp4g/fpc-deployer';
import { getDeployerCredentials, getFPCAddress, getL2Config } from './utils';

async function status() {
    const deployer = process.env.FPC_DEPLOYER_SECRET_KEY &&
        process.env.FPC_DEPLOYER_SIGNING_KEY &&
        process.env.FPC_DEPLOYER_SALT
        ? getDeployerCredentials()
        : undefined;

    const result = await statusAztecFPC({
        ...getL2Config(),
        fpcAddress: getFPCAddress(),
        deployer,
    });

    console.log(`\nSponsoredFPC address: ${result.fpcAddress}`);
    if (result.deployerAddress) console.log(`Deployer address:    ${result.deployerAddress}`);
    if (result.deployerBalance !== undefined) console.log(`Deployer fee juice:  ${result.deployerBalance}`);
    if (result.fpcBalance !== undefined) console.log(`FPC fee juice:       ${result.fpcBalance}`);
    if (!deployer) console.log('Deployer: not bootstrapped (run `yarn fpc:bootstrap`)');
}

status().catch((err) => {
    console.error('Status failed:', err);
    process.exit(1);
});
