import { Fr } from '@aztec/aztec.js/fields';
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import { ProtocolContractAddress } from '@aztec/aztec.js/protocol';
import { getNonNullifiedL1ToL2MessageWitness } from '@aztec/stdlib/messaging';
import { FeeAssetHandlerAbi } from '@aztec/l1-artifacts/FeeAssetHandlerAbi';
import { getCanonicalFeeJuice } from '@aztec/protocol-contracts/fee-juice';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { createLogger } from '@aztec/foundation/log';
import { getContract } from 'viem';
import {
    getNode,
    createL1Client,
    createFreshL1Client,
    createWalletWithoutFPC,
    loadFPCDeployerAccount,
    getFPCAddress,
} from './utils';

const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL = 30_000;
const MINT_AMOUNT = 1_000_000_000_000_000_000_000n; // 1000e18 per mint

async function fund() {
    const logger = createLogger('fpc:fund');

    const requestedTokens = BigInt(process.argv[2] ?? '1000');
    const requestedRaw = requestedTokens * 10n ** 18n;

    const { wallet, node } = await createWalletWithoutFPC();
    const account = await loadFPCDeployerAccount(wallet);
    const fpcAddress = getFPCAddress();
    logger.info(`Funding FPC at ${fpcAddress} with ${requestedTokens} fee juice tokens`);

    // 1. Create L1 client and portal
    const l1Client = createL1Client();
    const portal = await L1FeeJuicePortalManager.new(node, l1Client, logger);
    const tokenManager = portal.getTokenManager();

    // 2. Check balance and mint as needed
    let balance = await tokenManager.getL1TokenBalance(l1Client.account.address);
    logger.info(`L1 fee juice balance: ${balance}`);

    while (balance < requestedRaw) {
        logger.info(`Balance ${balance} < requested ${requestedRaw}, minting...`);
        const handler = getContract({
            address: tokenManager.handlerAddress!.toString() as `0x${string}`,
            abi: FeeAssetHandlerAbi,
            client: l1Client,
        });
        const mintHash = await handler.write.mint([l1Client.account.address]);
        logger.info(`Waiting for mint tx: ${mintHash}`);
        await l1Client.waitForTransactionReceipt({ hash: mintHash });

        balance = await tokenManager.getL1TokenBalance(l1Client.account.address);
        logger.info(`L1 balance after mint: ${balance}`);
    }

    // 3. Bridge tokens (fresh client to avoid nonce issues)
    const freshClient = createFreshL1Client();
    const freshPortal = await L1FeeJuicePortalManager.new(node, freshClient, logger);
    const claim = await freshPortal.bridgeTokensPublic(fpcAddress, requestedRaw, false);
    logger.info(`Bridged! Claim amount: ${claim.claimAmount}, hash: ${claim.messageHash}`);

    // 4. Poll for L1->L2 message
    logger.info(`Waiting for L1->L2 message...`);
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

    // 5. Register FeeJuice contract and claim
    const feeJuiceInstance = await getCanonicalFeeJuice();
    await wallet.registerContract(feeJuiceInstance.instance, FeeJuiceContract.artifact);
    const feeJuice = await FeeJuiceContract.at(feeJuiceInstance.address, wallet);

    logger.info(`Claiming fee juice for FPC...`);
    await feeJuice.methods
        .claim(fpcAddress, claim.claimAmount, claim.claimSecret, claim.messageLeafIndex)
        .send({ from: account.address });

    // 6. Check new balance
    const newBalance = await feeJuice.methods.balance_of_public(fpcAddress).simulate({
        from: account.address,
    });
    logger.info(`FPC fee juice balance: ${newBalance.result ?? newBalance}`);

    console.log(`\nFPC ${fpcAddress} funded. Balance: ${newBalance.result ?? newBalance}`);
}

fund().catch((err) => {
    console.error('Fund failed:', err);
    process.exit(1);
});
