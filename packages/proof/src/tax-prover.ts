import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { i64ToField } from './swap-proof-tree';
import type { SwapProofTreeResult, VkeyArtifacts } from './swap-proof-tree';
import { parseSignedHex, proofBytesToFields } from './utils';
import { log } from './logger';

export interface TaxProofResult {
    proof: Uint8Array;
    publicInputs: {
        root: string;
        tax: bigint;
        remainingLotStateRoot: string;
        initialLotStateRoot: string;
        priceFeedAddress: string;
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

        log('Initializing TaxProver...');
        this.noir = new Noir(this.taxCircuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(
            this.taxCircuit.bytecode,
            this.bb,
        );
        log('TaxProver initialized');
    }

    async prove(summaryResult: SwapProofTreeResult): Promise<TaxProofResult> {
        await this.initialize();

        log('\n=== TaxProver: Computing capital gains tax ===');

        const proofAsFields = proofBytesToFields(summaryResult.proof);

        const publicInputs = [
            summaryResult.publicInputs.root,
            i64ToField(summaryResult.publicInputs.pnl),
            summaryResult.publicInputs.remainingLotStateRoot,
            summaryResult.publicInputs.initialLotStateRoot,
            summaryResult.publicInputs.priceFeedAddress,
        ];

        const circuitInputs = {
            verification_key: this.summaryVkey.vkAsFields,
            vkey_hash: this.summaryVkey.vkHash,
            proof: proofAsFields,
            public_inputs: publicInputs,
            summary_vkey_hash: this.summaryVkey.vkHash,
        };

        log('  Executing tax circuit...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [root, taxStr, remainingRoot, initialRoot, priceFeedAddr] =
            returnValue as [string, string, string, string, string];

        log('  Generating proof...');
        const proof = await this.backend!.generateProof(witness);
        const isValid = await this.backend!.verifyProof(proof);
        if (!isValid) {
            throw new Error('Invalid tax proof');
        }

        const tax = parseSignedHex(taxStr);

        log(`  Tax (20%): ${tax}`);
        log(`  Proof: valid`);

        return {
            proof: proof.proof,
            publicInputs: {
                root,
                tax,
                remainingLotStateRoot: remainingRoot,
                initialLotStateRoot: initialRoot,
                priceFeedAddress: priceFeedAddr,
            },
        };
    }

    async verifyProof(
        proof: Uint8Array,
        publicInputs: {
            root: string;
            tax: string;
            remainingLotStateRoot: string;
            initialLotStateRoot: string;
            priceFeedAddress: string;
        },
    ): Promise<boolean> {
        await this.initialize();

        return this.backend!.verifyProof({
            proof,
            publicInputs: [
                publicInputs.root,
                publicInputs.tax,
                publicInputs.remainingLotStateRoot,
                publicInputs.initialLotStateRoot,
                publicInputs.priceFeedAddress,
            ],
        });
    }

}
