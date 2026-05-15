import { claimAztecFPC, fundAztecFPC } from '@jp4g/fpc-deployer';
import { getDeployerCredentials, getFPCAddress, getL1Config, getL2Config } from './utils';

function getRequestedAmount(): bigint {
    const amountFlag = process.argv.indexOf('--amount');
    const tokenArg = amountFlag !== -1 ? process.argv[amountFlag + 1] : process.argv[2];
    const tokens = BigInt(tokenArg ?? '1000');
    return tokens * 10n ** 18n;
}

async function fund() {
    const shared = {
        ...getL2Config(),
        ...getDeployerCredentials(),
        fpcAddress: getFPCAddress(),
    };

    const fundResult = await fundAztecFPC({
        ...shared,
        ...getL1Config(),
        amount: getRequestedAmount(),
    });

    const claimResult = await claimAztecFPC({
        ...shared,
        claim: fundResult.claim,
    });

    console.log(`\nFPC ${claimResult.fpcAddress} funded. Balance: ${claimResult.balance}`);
}

fund().catch((err) => {
    console.error('Fund failed:', err);
    process.exit(1);
});
