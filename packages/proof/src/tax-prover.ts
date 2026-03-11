import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { fieldToI64, i64ToField } from './swap-proof-tree';
import type { SwapProofTreeResult, VkeyArtifacts } from './swap-proof-tree';
import { parseSignedHex, proofBytesToFields } from './utils';

export interface TaxProofResult {
    proof: Uint8Array;
    publicInputs: {
        root: string;
        pnl: bigint;
        tax: bigint;
        remainingLotStateRoot: string;
        initialLotStateRoot: string;
        priceFeedAddress: string;
        blockNumber: bigint;
    };
}

export class TaxProver {
    private bb: Barretenberg;
    private taxCircuit: CompiledCircuit;
    private summaryVkey: VkeyArtifacts;
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;

    constructor(bb: Barretenberg, taxCircuit: CompiledCircuit, summaryVkey: VkeyArtifacts) {
        this.bb = bb;
        this.taxCircuit = taxCircuit;
        this.summaryVkey = summaryVkey;
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing TaxProver...');
        this.noir = new Noir(this.taxCircuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(
            this.taxCircuit.bytecode,
            this.bb,
        );
        console.log('TaxProver initialized');
    }

    async prove(summaryResult: SwapProofTreeResult): Promise<TaxProofResult> {
        await this.initialize();

        console.log('\n=== TaxProver: Computing capital gains tax ===');

        const proofAsFields = proofBytesToFields(summaryResult.proof);

        const publicInputs = [
            summaryResult.publicInputs.root,
            i64ToField(summaryResult.publicInputs.pnl),
            summaryResult.publicInputs.remainingLotStateRoot,
            summaryResult.publicInputs.initialLotStateRoot,
            summaryResult.publicInputs.priceFeedAddress,
            summaryResult.publicInputs.blockNumber.toString(),
        ];

        const circuitInputs = {
            verification_key: this.summaryVkey.vkAsFields,
            vkey_hash: this.summaryVkey.vkHash,
            proof: proofAsFields,
            public_inputs: publicInputs,
            summary_vkey_hash: this.summaryVkey.vkHash,
        };

        console.log('  Executing tax circuit...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [root, pnlStr, taxStr, remainingRoot, initialRoot, priceFeedAddr, blockNum] =
            returnValue as [string, string, string, string, string, string, string];

        console.log('  Generating proof...');
        const proof = await this.backend!.generateProof(witness);
        const isValid = await this.backend!.verifyProof(proof);
        if (!isValid) {
            throw new Error('Invalid tax proof');
        }

        const pnl = parseSignedHex(pnlStr);
        const tax = parseSignedHex(taxStr);

        console.log(`  PnL: ${pnl}`);
        console.log(`  Tax (20%): ${tax}`);
        console.log(`  Proof: valid`);

        return {
            proof: proof.proof,
            publicInputs: {
                root,
                pnl,
                tax,
                remainingLotStateRoot: remainingRoot,
                initialLotStateRoot: initialRoot,
                priceFeedAddress: priceFeedAddr,
                blockNumber: BigInt(blockNum),
            },
        };
    }

}
