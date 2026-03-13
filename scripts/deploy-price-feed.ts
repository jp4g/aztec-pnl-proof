/**
 * Minimal test: deploy a PriceFeed contract and call set_price / get_price.
 *
 * Usage: npx bun scripts/deploy-price-feed.ts
 */
import 'dotenv/config';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/foundation/curves/bn254';
import { PriceFeedContract } from '@privpnl/contracts/PriceFeed';
import { initializeWallet, makeSendOpts, registerSandboxAccounts } from './utils';

const { AZTEC_NODE_URL = 'http://localhost:8080' } = process.env;

async function main() {
    const { wallet, isDevnet, fpcAddress } = await initializeWallet(AZTEC_NODE_URL);
    const sendOpts = makeSendOpts(isDevnet, fpcAddress);

    let admin: AztecAddress;

    if (isDevnet) {
        console.log('Devnet — deploying a fresh account...');
        const fpcPaymentMethod = new SponsoredFeePaymentMethod(fpcAddress!);
        const secret = Fr.random();
        const signingKey = Fr.random();
        const manager = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKey);
        const deployMethod = await manager.getDeployMethod();
        await deployMethod.send({
            from: AztecAddress.ZERO,
            fee: { paymentMethod: fpcPaymentMethod },
            wait: { timeout: 600 },
        });
        admin = manager.address;

        // Force note sync
        const pxeDebug = (wallet.pxe as any).debug;
        const notes = await pxeDebug.getNotes({ contractAddress: admin, scopes: [admin] });
        console.log(`  Account notes: ${notes.length}`);
    } else {
        const { addresses } = await registerSandboxAccounts(wallet);
        admin = addresses[0];
    }

    console.log(`Admin: ${admin}`);

    // Deploy PriceFeed
    console.log('Deploying PriceFeed...');
    const deployResult = await PriceFeedContract.deploy(wallet).send(sendOpts(admin));
    console.log('deploy result keys:', Object.keys(deployResult));

    // Handle both possible return shapes
    const priceFeed = (deployResult as any).methods
        ? (deployResult as any)
        : (deployResult as any).contract;

    console.log(`PriceFeed deployed at: ${priceFeed.address}`);
    console.log('priceFeed.methods:', Object.keys(priceFeed.methods));

    // Set a price for a fake token
    const fakeTokenId = Fr.random();
    const price = 42000n;
    console.log(`Setting price for ${fakeTokenId} to ${price}...`);
    await priceFeed.methods.set_price(fakeTokenId, price).send(sendOpts(admin));
    console.log('✓ set_price succeeded');

    // Read it back
    console.log('Reading price back...');
    const asset = await priceFeed.methods.get_price(fakeTokenId).simulate({ from: admin });
    console.log(`✓ get_price returned: price=${asset.result.price}`);
}

main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
