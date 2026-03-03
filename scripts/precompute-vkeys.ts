/**
 * Precompute verification keys for the individual_swap and swap_summary_tree circuits.
 * These are deterministic (depend only on circuit bytecode) and expensive to compute,
 * so we save them to disk for reuse by the test and frontend.
 *
 * Usage: bun scripts/precompute-vkeys.ts
 */

import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

async function main() {
    console.log('=== Precomputing verification keys ===\n');

    // Load circuit artifacts
    const circuitsDir = join(process.cwd(), 'circuits');
    const leafCircuit = JSON.parse(
        await readFile(join(circuitsDir, 'individual_swap/target/individual_swap.json'), 'utf-8'),
    );
    const summaryCircuit = JSON.parse(
        await readFile(join(circuitsDir, 'swap_summary_tree/target/swap_summary_tree.json'), 'utf-8'),
    );

    console.log('Initializing Barretenberg...');
    const bb = await Barretenberg.new({ threads: 1 });

    // Leaf circuit vkey
    console.log('Computing leaf circuit vkey...');
    const leafBackend = new UltraHonkBackend(leafCircuit.bytecode, bb);
    const leafArtifacts = await leafBackend.generateRecursiveProofArtifacts(
        new Uint8Array(0), // unused
        6, // unused
    );
    console.log(`  Leaf vkey hash: ${leafArtifacts.vkHash}`);
    console.log(`  Leaf vkey fields: ${leafArtifacts.vkAsFields.length}`);

    // Summary circuit vkey
    console.log('Computing summary circuit vkey...');
    const summaryBackend = new UltraHonkBackend(summaryCircuit.bytecode, bb);
    const summaryArtifacts = await summaryBackend.generateRecursiveProofArtifacts(
        new Uint8Array(0), // unused
        6, // unused
        { verifierTarget: 'noir-recursive' },
    );
    console.log(`  Summary vkey hash: ${summaryArtifacts.vkHash}`);
    console.log(`  Summary vkey fields: ${summaryArtifacts.vkAsFields.length}`);

    // Save to disk
    const outDir = join(process.cwd(), 'circuits', 'vkeys');
    await mkdir(outDir, { recursive: true });

    const vkeys = {
        leaf: {
            vkAsFields: leafArtifacts.vkAsFields,
            vkHash: leafArtifacts.vkHash,
        },
        summary: {
            vkAsFields: summaryArtifacts.vkAsFields,
            vkHash: summaryArtifacts.vkHash,
        },
    };

    const outPath = join(outDir, 'vkeys.json');
    await writeFile(outPath, JSON.stringify(vkeys, null, 2));
    console.log(`\nSaved to ${outPath}`);

    // Also copy to frontend public dir for browser access
    const publicDir = join(process.cwd(), 'frontend', 'public', 'circuits');
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, 'vkeys.json'), JSON.stringify(vkeys));
    console.log(`Copied to ${join(publicDir, 'vkeys.json')}`);

    bb.destroy();
    console.log('\n=== Done ===');
}

main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
