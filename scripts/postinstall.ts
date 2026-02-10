import { $ } from 'bun';

async function postinstall() {
  try {
    // Compile token contract and generate TS artifact
    console.log('Compiling token contract...');
    await $`cd contracts/token_contract && aztec compile`;
    console.log('✓ Token contract compiled');

    console.log('Generating Token TS artifact...');
    await $`aztec codegen contracts/token_contract/target -o src/artifacts/`;
    console.log('✓ Token artifact generated');

    // Compile AMM contract and generate TS artifact
    console.log('Compiling AMM contract...');
    await $`cd contracts/amm_contract && aztec compile`;
    console.log('✓ AMM contract compiled');

    console.log('Generating AMM TS artifact...');
    await $`aztec codegen contracts/amm_contract/target -o src/artifacts/`;
    console.log('✓ AMM artifact generated');

    // Compile Noir circuits
    console.log('Compiling individual_swap circuit...');
    await $`cd circuits/individual_swap && nargo compile`;
    console.log('✓ individual_swap compiled');

    console.log('Compiling swap_summary_tree circuit...');
    await $`cd circuits/swap_summary_tree && nargo compile`;
    console.log('✓ swap_summary_tree compiled');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

postinstall();
