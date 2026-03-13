import { Fr } from '@aztec/aztec.js/fields';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createLogger } from '@aztec/foundation/log';
import { createWalletWithoutFPC, loadFPCDeployerAccount, getFPCAddress } from './utils';

async function test() {
    const logger = createLogger('fpc:test');

    const { wallet, node } = await createWalletWithoutFPC();
    await loadFPCDeployerAccount(wallet);

    // 1. Register the SponsoredFPC contract
    const fpcAddress = getFPCAddress();
    const fpcInstance = await node.getContract(fpcAddress);
    if (!fpcInstance) {
        throw new Error(`SponsoredFPC not found on-chain at ${fpcAddress}`);
    }
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    logger.info(`SponsoredFPC registered at ${fpcAddress}`);

    // 2. Create sponsored fee payment method
    const paymentMethod = new SponsoredFeePaymentMethod(fpcAddress);

    // 3. Generate a random test account
    const secretKey = Fr.random();
    const signingKey = GrumpkinScalar.random();
    const salt = Fr.random();
    const testAccount = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
    logger.info(`Test account address: ${testAccount.address}`);

    // 4. Deploy with sponsored fees
    const deployMethod = await testAccount.getDeployMethod();
    await deployMethod.simulate({ from: AztecAddress.ZERO });
    logger.info(`Simulation passed, deploying test account with sponsored fees...`);

    await deployMethod.send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod },
    });

    logger.info(`Test account deployed successfully at ${testAccount.address}`);
    console.log(`\nTest account deployed: ${testAccount.address}`);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
