import { getCanonicalFeeJuice } from '@aztec/protocol-contracts/fee-juice';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { createLogger } from '@aztec/foundation/log';
import { createWalletWithoutFPC, loadFPCDeployerAccount, getFPCAddress } from './utils';

async function status() {
    const logger = createLogger('fpc:status');

    const fpcAddress = getFPCAddress();
    console.log(`\nSponsoredFPC address: ${fpcAddress}`);

    if (!process.env.FPC_DEPLOYER_SECRET_KEY || !process.env.FPC_DEPLOYER_SIGNING_KEY || !process.env.FPC_DEPLOYER_SALT) {
        console.log(`Deployer: not bootstrapped (run \`yarn fpc:bootstrap\`)`);
        return;
    }

    try {
        const { wallet } = await createWalletWithoutFPC();
        const account = await loadFPCDeployerAccount(wallet);
        console.log(`Deployer address:    ${account.address}`);

        // Register FeeJuice to query balances
        const feeJuiceInstance = await getCanonicalFeeJuice();
        await wallet.registerContract(feeJuiceInstance.instance, FeeJuiceContract.artifact);
        const feeJuice = await FeeJuiceContract.at(feeJuiceInstance.address, wallet);

        const deployerBalance = await feeJuice.methods
            .balance_of_public(account.address)
            .simulate({ from: account.address });
        console.log(`Deployer fee juice:  ${deployerBalance.result ?? deployerBalance}`);

        const fpcBalance = await feeJuice.methods
            .balance_of_public(fpcAddress)
            .simulate({ from: account.address });
        console.log(`FPC fee juice:       ${fpcBalance.result ?? fpcBalance}`);
    } catch (e: any) {
        logger.warn(`Could not query balances: ${e.message}`);
    }
}

status().catch((err) => {
    console.error('Status failed:', err);
    process.exit(1);
});
