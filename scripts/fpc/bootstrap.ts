import { Fr } from '@aztec/aztec.js/fields';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { ProtocolContractAddress } from '@aztec/aztec.js/protocol';
import { getNonNullifiedL1ToL2MessageWitness } from '@aztec/stdlib/messaging';
import { FeeAssetHandlerAbi } from '@aztec/l1-artifacts/FeeAssetHandlerAbi';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createLogger } from '@aztec/foundation/log';
import { getContract } from 'viem';
import { getNode, createL1Client, createFreshL1Client, createWalletWithoutFPC, upsertEnvVar } from './utils';

const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n; // 1000e18
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL = 30_000;

async function bootstrap() {
    const logger = createLogger('fpc:bootstrap');

    // 1. Generate random account keys
    const secretKey = Fr.random();
    const signingKey = GrumpkinScalar.random();
    const salt = Fr.random();

    logger.info(`Generated deployer keys`);
    logger.info(`  Secret key:  ${secretKey.toString()}`);
    logger.info(`  Signing key: ${signingKey.toString()}`);
    logger.info(`  Salt:        ${salt.toString()}`);

    // 2. Create wallet and account
    const { wallet, node } = await createWalletWithoutFPC();
    const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
    logger.info(`Deployer address: ${account.address}`);

    // 3. Create L1 client and portal
    const l1Client = createL1Client();
    const portal = await L1FeeJuicePortalManager.new(node, l1Client, logger);
    const tokenManager = portal.getTokenManager();

    // 4. Check L1 balance and mint if needed
    const balance = await tokenManager.getL1TokenBalance(l1Client.account.address);
    if (balance < FEE_JUICE_AMOUNT) {
        logger.info(`L1 fee juice balance: ${balance}. Minting...`);
        const handler = getContract({
            address: tokenManager.handlerAddress!.toString() as `0x${string}`,
            abi: FeeAssetHandlerAbi,
            client: l1Client,
        });
        const mintHash = await handler.write.mint([l1Client.account.address]);
        logger.info(`Waiting for mint tx: ${mintHash}`);
        await l1Client.waitForTransactionReceipt({ hash: mintHash });
        logger.info(`Mint confirmed`);
    } else {
        logger.info(`L1 balance sufficient: ${balance}`);
    }

    // 5. Bridge tokens to account (fresh client to avoid nonce issues)
    const freshClient = createFreshL1Client();
    const freshPortal = await L1FeeJuicePortalManager.new(node, freshClient, logger);
    const claim = await freshPortal.bridgeTokensPublic(account.address, FEE_JUICE_AMOUNT, false);
    logger.info(`Bridged! Claim amount: ${claim.claimAmount}, hash: ${claim.messageHash}`);

    // 6. Poll for L1->L2 message
    logger.info(`Waiting for L1->L2 message on L2...`);
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        const witness = await getNonNullifiedL1ToL2MessageWitness(
            node,
            ProtocolContractAddress.FeeJuice,
            Fr.fromHexString(claim.messageHash),
            claim.claimSecret,
        ).catch(() => undefined);

        if (witness) {
            logger.info(`L1->L2 message available!`);
            break;
        }

        if (i === MAX_POLL_ATTEMPTS - 1) {
            throw new Error(`L1->L2 message not available after ${MAX_POLL_ATTEMPTS * 30}s`);
        }

        logger.info(`Not yet available, retrying in ${POLL_INTERVAL / 1000}s... (${i + 1}/${MAX_POLL_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // 7. Deploy account with FeeJuicePaymentMethodWithClaim
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(account.address, claim);
    const deployMethod = await account.getDeployMethod();

    await deployMethod.simulate({ from: AztecAddress.ZERO });
    logger.info(`Simulation passed, deploying account...`);

    await deployMethod.send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod },
    });
    logger.info(`Account deployed at ${account.address}`);

    // 8. Save keys to .env
    upsertEnvVar('FPC_DEPLOYER_SECRET_KEY', secretKey.toString());
    upsertEnvVar('FPC_DEPLOYER_SIGNING_KEY', signingKey.toString());
    upsertEnvVar('FPC_DEPLOYER_SALT', salt.toString());
    logger.info(`Keys saved to .env`);

    console.log(`\nDeployer address: ${account.address}`);
}

bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
