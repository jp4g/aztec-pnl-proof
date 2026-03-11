import { execSync } from 'node:child_process';
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function run(cmd: string, cwd?: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

async function copyFileWithLog(src: string, dest: string) {
  await copyFile(src, dest);
  console.log(`Copied: ${src} → ${dest}`);
}

async function replaceInFile(filePath: string, searchText: string, replaceText: string) {
  const content = await readFile(filePath, 'utf-8');
  const updatedContent = content.replace(
    new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    replaceText,
  );
  await writeFile(filePath, updatedContent, 'utf-8');
  console.log(`Updated imports in: ${filePath}`);
}

async function computeVkeys(circuitsDir: string) {
  const { Barretenberg, UltraHonkBackend } = await import('@aztec/bb.js');

  const leafCircuit = JSON.parse(
    await readFile(join(circuitsDir, 'target', 'individual_swap.json'), 'utf-8'),
  );
  const summaryCircuit = JSON.parse(
    await readFile(join(circuitsDir, 'target', 'swap_summary_tree.json'), 'utf-8'),
  );

  console.log('Initializing Barretenberg...');
  const bb = await Barretenberg.new({ threads: 1 });

  console.log('Computing leaf circuit vkey...');
  const leafBackend = new UltraHonkBackend(leafCircuit.bytecode, bb);
  const leafArtifacts = await leafBackend.generateRecursiveProofArtifacts(
    new Uint8Array(0),
    6,
  );
  console.log(`  Leaf vkey hash: ${leafArtifacts.vkHash}`);

  console.log('Computing summary circuit vkey...');
  const summaryBackend = new UltraHonkBackend(summaryCircuit.bytecode, bb);
  const summaryArtifacts = await summaryBackend.generateRecursiveProofArtifacts(
    new Uint8Array(0),
    6,
    { verifierTarget: 'noir-recursive' },
  );
  console.log(`  Summary vkey hash: ${summaryArtifacts.vkHash}`);

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

  // Save to circuits ts/
  const vkeysPath = join(circuitsDir, 'ts', 'vkeys.json');
  await writeFile(vkeysPath, JSON.stringify(vkeys, null, 2));
  console.log(`Saved vkeys to ${vkeysPath}`);

  // Copy to frontend public dir for browser access
  const publicDir = join(process.cwd(), 'packages', 'frontend', 'public', 'circuits');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'vkeys.json'), JSON.stringify(vkeys));
  console.log(`Copied vkeys to ${join(publicDir, 'vkeys.json')}`);

  bb.destroy();
}

async function postinstall() {
  const contractsDir = join(process.cwd(), 'packages', 'contracts');
  const circuitsDir = join(process.cwd(), 'packages', 'circuits');

  // --- Compile AMM contract + codegen ---
  console.log('Compiling AMM contract...');
  run('aztec compile', join(contractsDir, 'amm_contract'));
  console.log('✓ AMM contract compiled');

  console.log('Generating AMM TS artifact...');
  run(`aztec codegen ${join(contractsDir, 'amm_contract', 'target')} -o ${join(contractsDir, 'src')}/`);
  console.log('✓ AMM artifact generated');

  // Copy contract artifact + patch import
  await copyFileWithLog(
    join(contractsDir, 'amm_contract', 'target', 'amm_contract-AMM.json'),
    join(contractsDir, 'src', 'AMM.json'),
  );
  await replaceInFile(
    join(contractsDir, 'src', 'AMM.ts'),
    '../amm_contract/target/amm_contract-AMM.json',
    './AMM.json',
  );

  // --- Compile all Noir circuits (workspace) ---
  console.log('Compiling Noir circuits...');
  run('nargo compile', circuitsDir);
  console.log('✓ All circuits compiled');

  // Copy circuit artifacts to ts/ and frontend public dir
  const publicDir = join(process.cwd(), 'packages', 'frontend', 'public', 'circuits');
  await mkdir(publicDir, { recursive: true });
  for (const name of ['individual_swap', 'swap_summary_tree', 'capital_gains_tax']) {
    await copyFileWithLog(
      join(circuitsDir, 'target', `${name}.json`),
      join(circuitsDir, 'ts', `${name}.json`),
    );
    await copyFileWithLog(
      join(circuitsDir, 'target', `${name}.json`),
      join(publicDir, `${name}.json`),
    );
  }

  // --- Compute verification keys ---
  console.log('Computing verification keys...');
  await computeVkeys(circuitsDir);
  console.log('✓ Verification keys computed');
}

postinstall().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
