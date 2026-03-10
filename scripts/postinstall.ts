import { $ } from 'bun';

async function postinstall() {
  try {
    // Compile AMM contract and generate TS artifact
    console.log('Compiling AMM contract...');
    await $`cd packages/contracts/amm_contract && aztec compile`;
    console.log('✓ AMM contract compiled');

    console.log('Generating AMM TS artifact...');
    await $`aztec codegen packages/contracts/amm_contract/target -o packages/contracts/src/`;
    console.log('✓ AMM artifact generated');

    // Compile Noir circuits
    console.log('Compiling individual_swap circuit...');
    await $`cd packages/circuits/individual_swap && nargo compile`;
    console.log('✓ individual_swap compiled');

    console.log('Compiling swap_summary_tree circuit...');
    await $`cd packages/circuits/swap_summary_tree && nargo compile`;
    console.log('✓ swap_summary_tree compiled');

    console.log('Compiling capital_gains_tax circuit...');
    await $`cd packages/circuits/capital_gains_tax && nargo compile`;
    console.log('✓ capital_gains_tax compiled');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

postinstall();
