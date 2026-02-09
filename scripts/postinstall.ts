import { join } from 'path';
import { $ } from 'bun';
import { readFile, writeFile } from 'fs/promises';

async function replaceInFile(filePath: string, searchText: string, replaceText: string) {
  try {
    const content = await readFile(filePath, "utf-8");
    const updatedContent = content.replace(new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replaceText);
    await writeFile(filePath, updatedContent, "utf-8");
    console.log(`Updated imports in: ${filePath}`);
  } catch (error) {
    throw new Error(`Failed to update file ${filePath}: ${error}`);
  }
}

async function postinstall() {
  const submodulePath = join(process.cwd(), 'deps', 'aztec-standard');
  const submoduleMarker = join(submodulePath, '.git');

  console.log('Initializing git submodules...');

  try {
    // Initialize and update git submodules
    await $`git submodule update --init --recursive`;

    // Checkout the specific tag
    await $`cd ${submodulePath} && git checkout v3.0.0-devnet.6-patch.1`;

    // Change to submodule directory for compilation
    process.chdir(submodulePath);

    // build the token dep
    console.log('Compiling AIP20 token contract');
    await $`aztec compile --package token_contract`;

    // codegen the typescript interface
    console.log('Generating TS interface');
    await $`aztec codegen ./target/token_contract-Token.json -o ./target -f`;

    // copy the artifacts
    console.log("Copying artifacts")
    await $`cp ./target/token_contract-Token.json ../../src/artifacts/Token.json`;
    await $`cp ./target/Token.ts ../../src/artifacts/Token.ts`;
    await replaceInFile(
      "../../src/artifacts/Token.ts",
      "./token_contract-Token.json",
      "./Token.json"
    );
    console.log('✓ Token artifact successfully built');

    // Change back to project root for circuit compilation
    process.chdir(join(process.cwd(), '..', '..'));

    // Compile AMM contract and generate TS artifact
    console.log('Compiling AMM contract...');
    await $`cd contracts/amm_contract && aztec compile`;
    console.log('✓ AMM contract compiled');

    console.log('Generating AMM TS artifact...');
    await $`aztec codegen contracts/amm_contract/target/amm_contract-AMM.json -o src/artifacts/`;
    console.log('✓ AMM artifact generated');

    // Compile Noir circuits
    console.log('Compiling spot_price circuit...');
    await $`cd circuits/spot_price && nargo compile`;
    console.log('✓ spot_price compiled');

    console.log('Compiling note_creation circuit...');
    await $`cd circuits/note_creation && nargo compile`;
    console.log('✓ note_creation compiled');

    console.log('Compiling individual_swap circuit...');
    await $`cd circuits/individual_swap && nargo compile`;
    console.log('✓ individual_swap compiled');

  } catch (error) {
    console.error('Failed to initialize git submodules:', error);
    process.exit(1);
  }
}

postinstall();
