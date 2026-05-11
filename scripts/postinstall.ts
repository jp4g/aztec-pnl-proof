import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const FRONTEND_CIRCUITS_DIR = join(process.cwd(), 'packages', 'frontend', 'public', 'circuits');

type BuildMode = 'all' | 'contracts' | 'circuits';

function run(cmd: string, args: string[], cwd?: string) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: getToolchainEnv() });
}

function getAztecToolPath(tool: 'aztec' | 'nargo') {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set; cannot locate aztec-up toolchain');
  }

  const aztecVersion = getAztecVersionFromRcFile();
  if (!aztecVersion) {
    throw new Error('Missing .aztecrc; run `aztec-up use <version>` and commit the repo .aztecrc');
  }

  const aztecRoot = join(home, '.aztec', 'versions', aztecVersion);
  const toolPath = tool === 'aztec'
    ? join(aztecRoot, 'node_modules', '.bin', 'aztec')
    : join(aztecRoot, 'bin', 'nargo');

  if (!existsSync(toolPath)) {
    throw new Error(`Missing ${tool} for Aztec ${aztecVersion}. Run \`aztec-up install ${aztecVersion}\`.`);
  }

  return toolPath;
}

function getToolchainEnv() {
  const home = process.env.HOME;
  const aztecVersion = getAztecVersionFromRcFile();
  if (!home || !aztecVersion) {
    return process.env;
  }

  const aztecRoot = join(home, '.aztec', 'versions', aztecVersion);
  const toolDirs = [
    join(aztecRoot, 'bin'),
    join(aztecRoot, 'node_modules', '.bin'),
  ].filter(path => existsSync(path));

  return {
    ...process.env,
    PATH: [...toolDirs, process.env.PATH ?? ''].join(delimiter),
  };
}

function getAztecVersionFromRcFile() {
  const aztecRcPath = join(process.cwd(), '.aztecrc');
  if (!existsSync(aztecRcPath)) {
    return undefined;
  }

  const version = readFileSync(aztecRcPath, 'utf-8').trim();
  return version || undefined;
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
  await writeFile(join(FRONTEND_CIRCUITS_DIR, 'vkeys.json'), JSON.stringify(vkeys));
  console.log(`Copied vkeys to ${join(FRONTEND_CIRCUITS_DIR, 'vkeys.json')}`);

  bb.destroy();
}

async function compileContracts(contractsDir: string) {
  const aztec = getAztecToolPath('aztec');

  // --- Compile AMM contract + codegen ---
  console.log('Compiling AMM contract...');
  run(aztec, ['compile'], join(contractsDir, 'amm_contract'));
  console.log('✓ AMM contract compiled');

  console.log('Generating AMM TS artifact...');
  run(aztec, [
    'codegen',
    join(contractsDir, 'amm_contract', 'target'),
    '-o',
    `${join(contractsDir, 'src')}/`,
  ]);
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

  // --- Compile PriceFeed contract + codegen ---
  console.log('Compiling PriceFeed contract...');
  run(aztec, ['compile'], join(contractsDir, 'price_feed_contract'));
  console.log('✓ PriceFeed contract compiled');

  console.log('Generating PriceFeed TS artifact...');
  run(aztec, [
    'codegen',
    join(contractsDir, 'price_feed_contract', 'target'),
    '-o',
    `${join(contractsDir, 'src')}/`,
  ]);
  console.log('✓ PriceFeed artifact generated');

  // Copy contract artifact + patch import
  await copyFileWithLog(
    join(contractsDir, 'price_feed_contract', 'target', 'price_feed_contract-PriceFeed.json'),
    join(contractsDir, 'src', 'PriceFeed.json'),
  );
  await replaceInFile(
    join(contractsDir, 'src', 'PriceFeed.ts'),
    '../price_feed_contract/target/price_feed_contract-PriceFeed.json',
    './PriceFeed.json',
  );
}

async function compileCircuits(circuitsDir: string) {
  const nargo = getAztecToolPath('nargo');

  // --- Compile all Noir circuits (workspace) ---
  console.log('Compiling Noir circuits...');
  run(nargo, ['compile'], circuitsDir);
  console.log('✓ All circuits compiled');

  // Copy circuit artifacts to ts/ and frontend public dir
  await mkdir(FRONTEND_CIRCUITS_DIR, { recursive: true });
  for (const name of ['individual_swap', 'swap_summary_tree', 'capital_gains_tax']) {
    await copyFileWithLog(
      join(circuitsDir, 'target', `${name}.json`),
      join(circuitsDir, 'ts', `${name}.json`),
    );
    await copyFileWithLog(
      join(circuitsDir, 'target', `${name}.json`),
      join(FRONTEND_CIRCUITS_DIR, `${name}.json`),
    );
  }

  // --- Compute verification keys ---
  console.log('Computing verification keys...');
  await computeVkeys(circuitsDir);
  console.log('✓ Verification keys computed');
}

function getBuildMode(): BuildMode {
  const mode = process.argv[2] ?? 'all';
  if (mode === 'all' || mode === 'contracts' || mode === 'circuits') {
    return mode;
  }

  throw new Error(`Unknown build mode "${mode}". Expected all, contracts, or circuits.`);
}

async function postinstall() {
  const mode = getBuildMode();
  const contractsDir = join(process.cwd(), 'packages', 'contracts');
  const circuitsDir = join(process.cwd(), 'packages', 'circuits');

  if (mode === 'all' || mode === 'contracts') {
    await compileContracts(contractsDir);
  }

  if (mode === 'all' || mode === 'circuits') {
    await compileCircuits(circuitsDir);
  }
}

if (process.env.VERCEL) {
  console.log('Skipping postinstall on Vercel (artifacts are pre-built)');
} else {
  postinstall().catch((error) => {
    console.error('Build failed:', error);
    process.exit(1);
  });
}
