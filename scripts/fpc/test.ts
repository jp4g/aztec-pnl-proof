import { testAztecFPC } from '@jp4g/fpc-deployer';
import { getDeployerCredentials, getFPCAddress, getL2Config } from './utils';

async function test() {
    const result = await testAztecFPC({
        ...getL2Config(),
        ...getDeployerCredentials(),
        fpcAddress: getFPCAddress(),
    });

    console.log(`\nTest account deployed: ${result.testAccountAddress}`);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
