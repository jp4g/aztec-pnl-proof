import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { parseSignedHex, fieldToI64, i64ToField } from './swap-proof-tree';
import type { SwapProofTreeResult } from './swap-proof-tree';

import capitalGainsTaxCircuit from '../circuits/capital_gains_tax/target/capital_gains_tax.json' with { type: 'json' };

/** Number of public inputs from the summary tree proof */
const SUMMARY_PUBLIC_INPUTS = 6;

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
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;
    private summaryBackend: UltraHonkBackend | null = null;

    constructor(bb: Barretenberg, private summaryCircuit: CompiledCircuit) {
        this.bb = bb;
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing TaxProver...');
        this.noir = new Noir(capitalGainsTaxCircuit as CompiledCircuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(
            (capitalGainsTaxCircuit as CompiledCircuit).bytecode,
            this.bb,
        );
        this.summaryBackend = new UltraHonkBackend(
            this.summaryCircuit.bytecode,
            this.bb,
        );
        console.log('TaxProver initialized');
    }

    async prove(summaryResult: SwapProofTreeResult): Promise<TaxProofResult> {
        await this.initialize();

        console.log('\n=== TaxProver: Computing capital gains tax ===');

        // Get summary vkey artifacts
        const summaryArtifacts = await this.summaryBackend!.generateRecursiveProofArtifacts(
            summaryResult.proof,
            SUMMARY_PUBLIC_INPUTS,
        );

        // Convert proof bytes to field array
        const proofAsFields = this.proofBytesToFields(summaryResult.proof);

        // Build public inputs array (6 fields, with PnL as two's complement)
        const publicInputs = [
            summaryResult.publicInputs.root,
            i64ToField(summaryResult.publicInputs.pnl),
            summaryResult.publicInputs.remainingLotStateRoot,
            summaryResult.publicInputs.initialLotStateRoot,
            summaryResult.publicInputs.priceFeedAddress,
            summaryResult.publicInputs.blockNumber.toString(),
        ];

        const circuitInputs = {
            verification_key: summaryArtifacts.vkAsFields,
            vkey_hash: summaryArtifacts.vkHash,
            proof: proofAsFields,
            public_inputs: publicInputs,
            summary_vkey_hash: summaryArtifacts.vkHash,
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

    private proofBytesToFields(proofBytes: Uint8Array): string[] {
        const fields: string[] = [];
        for (let i = 0; i < proofBytes.length; i += 32) {
            const chunk = proofBytes.slice(i, i + 32);
            const hex = '0x' + Buffer.from(chunk).toString('hex');
            fields.push(hex);
        }
        return fields;
    }
}
