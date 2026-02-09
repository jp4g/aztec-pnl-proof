import { Fr } from '@aztec/foundation/curves/bn254';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { decryptLog } from './decrypt';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { CompleteAddress } from '@aztec/stdlib/contract';

/** MESSAGE_CIPHERTEXT_LEN from Aztec constants (17 fields) */
const MESSAGE_CIPHERTEXT_LEN = 17;

/**
 * Configuration for SwapProver
 */
export interface SwapProverConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled individual_swap circuit */
    circuit: CompiledCircuit;
    /** Recipient's complete address */
    recipientCompleteAddress: CompleteAddress;
    /** Master incoming viewing secret key */
    ivskM: Fr;
}

/**
 * Result of a swap event proof
 */
export interface SwapProofResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public outputs */
    publicInputs: {
        tokenIn: string;
        tokenOut: string;
        amountIn: bigint;
        amountOut: bigint;
        isExactInput: bigint;
    };
}

/**
 * SwapProver generates a proof that a swap event occurred with specific parameters.
 *
 * It takes a raw encrypted event ciphertext, decrypts it, and generates a ZK proof
 * that the ciphertext decrypts to the asserted swap parameters.
 */
export class SwapProver {
    private config: SwapProverConfig;

    // Lazy-initialized components
    private noir: Noir | null = null;
    private backend: UltraHonkBackend | null = null;
    private addressSecret: Fr | null = null;

    constructor(config: SwapProverConfig) {
        this.config = config;
    }

    /**
     * Prove a single swap event from its encrypted ciphertext.
     *
     * @param encryptedLog - Raw encrypted log buffer (includes 32-byte tag prefix)
     * @returns Proof and proven swap parameters
     */
    async prove(encryptedLog: Buffer): Promise<SwapProofResult> {
        await this.initialize();

        console.log(`\n=== SwapProver: Proving swap event ===`);
        console.log(`  Ciphertext size: ${encryptedLog.length} bytes`);

        // 1. Decrypt the event to get plaintext fields
        const plaintext = await decryptLog(
            encryptedLog,
            this.config.recipientCompleteAddress,
            this.config.ivskM,
        );
        if (!plaintext) {
            throw new Error('Failed to decrypt swap event');
        }

        console.log(`  Decrypted ${plaintext.length} plaintext fields`);
        for (let i = 0; i < plaintext.length; i++) {
            console.log(`    [${i}]: ${plaintext[i]}`);
        }

        // 2. Prepare circuit inputs
        const circuitInputs = this.prepareCircuitInputs(plaintext, encryptedLog);

        // 3. Generate witness
        console.log('  Generating witness...');
        const { witness, returnValue } = await this.noir!.execute(circuitInputs);
        const [tokenIn, tokenOut, amountIn, amountOut, isExactInput] =
            returnValue as [string, string, string, string, string];

        console.log(`  Proven token_in: ${tokenIn}`);
        console.log(`  Proven token_out: ${tokenOut}`);
        console.log(`  Proven amount_in: ${BigInt(amountIn)}`);
        console.log(`  Proven amount_out: ${BigInt(amountOut)}`);
        console.log(`  Proven is_exact_input: ${BigInt(isExactInput)}`);

        // 4. Generate proof
        console.log('  Generating proof...');
        const proof = await this.backend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
        const isValid = await this.backend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
        if (!isValid) {
            throw new Error('Swap proof verification failed');
        }
        console.log('  Proof verified!');

        return {
            proof: proof.proof,
            publicInputs: {
                tokenIn,
                tokenOut,
                amountIn: BigInt(amountIn),
                amountOut: BigInt(amountOut),
                isExactInput: BigInt(isExactInput),
            },
        };
    }

    /**
     * Prepare circuit inputs from decrypted plaintext and raw ciphertext.
     */
    private prepareCircuitInputs(
        plaintext: Fr[],
        encryptedLogBuffer: Buffer,
    ): { plaintext: { storage: string[]; len: string }; ciphertext: string[]; ivsk_app: string } {
        // Convert plaintext to BoundedVec format (max capacity 14)
        const plaintextStorage = plaintext.map(f => f.toString());
        const plaintextLen = plaintextStorage.length;
        while (plaintextStorage.length < 14) {
            plaintextStorage.push("0");
        }

        // Parse ciphertext: skip 32-byte tag, then read MESSAGE_CIPHERTEXT_LEN fields
        const ciphertextWithoutTag = encryptedLogBuffer.slice(32);
        const ciphertextFields: string[] = [];

        const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
        ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

        for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
            const chunk = paddedBuffer.slice(i * 32, (i + 1) * 32);
            const field = Fr.fromBuffer(chunk);
            ciphertextFields.push(field.toString());
        }

        return {
            plaintext: {
                storage: plaintextStorage,
                len: plaintextLen.toString(),
            },
            ciphertext: ciphertextFields,
            ivsk_app: this.addressSecret!.toString(),
        };
    }

    private async initialize(): Promise<void> {
        if (this.noir) return;

        console.log('Initializing SwapProver...');
        this.noir = new Noir(this.config.circuit);
        await this.noir.init();
        this.backend = new UltraHonkBackend(this.config.circuit.bytecode, this.config.bb);

        // Compute address secret (ivsk_app)
        const preaddress = await this.config.recipientCompleteAddress.getPreaddress();
        this.addressSecret = await computeAddressSecret(preaddress, this.config.ivskM);

        console.log('SwapProver initialized');
    }
}
