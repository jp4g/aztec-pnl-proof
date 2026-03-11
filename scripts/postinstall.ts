import { execSync } from 'node:child_process';

function run(cmd: string, cwd?: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

try {
  // Compile AMM contract and generate TS artifact
  console.log('Compiling AMM contract...');
  run('aztec compile', 'packages/contracts/amm_contract');
  console.log('✓ AMM contract compiled');

  console.log('Generating AMM TS artifact...');
  run('aztec codegen packages/contracts/amm_contract/target -o packages/contracts/src/');
  console.log('✓ AMM artifact generated');

  // Compile Noir circuits
  console.log('Compiling individual_swap circuit...');
  run('nargo compile', 'packages/circuits/individual_swap');
  console.log('✓ individual_swap compiled');

  console.log('Compiling swap_summary_tree circuit...');
  run('nargo compile', 'packages/circuits/swap_summary_tree');
  console.log('✓ swap_summary_tree compiled');

  console.log('Compiling capital_gains_tax circuit...');
  run('nargo compile', 'packages/circuits/capital_gains_tax');
  console.log('✓ capital_gains_tax compiled');

} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
