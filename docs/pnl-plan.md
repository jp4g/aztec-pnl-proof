# PnL Proof: Mark-to-Market via PriceFeed Oracle

## Context

We have a working swap proof pipeline: `individual_swap` proves each swap, `swap_summary_tree` aggregates into a merkle root. Now we need to compute PnL by pricing each swap's tokens via a PriceFeed oracle, proven with public storage proofs at each swap's block.

**PnL model**: Mark-to-market per swap. For each swap, look up `price_in` and `price_out` from PriceFeed at that block. `PnL = sum(amount_out * price_out) - sum(amount_in * price_in)`.

**Price source**: `@aztec/noir-contracts.js/PriceFeed`. Storage: `assets: Map<Field, PublicMutable<Asset>>` at **slot 1**. `Asset { price: u128 }`.

## Architecture

New `pnl_calculator` circuit that:
1. Re-derives each swap's leaf hash and builds the same merkle root as `swap_summary_tree` — this cryptographically binds PnL to the proven swap set
2. For each swap, does 2 public data tree Merkle proofs to read `price_in` and `price_out` from PriceFeed
3. Computes `total_value_in` and `total_value_out` separately (avoids signed arithmetic in-circuit)
4. Returns `pub (total_value_in, total_value_out, merkle_root, price_feed_address)`

Verifier checks `pnl_proof.merkle_root == swap_tree_proof.merkle_root`.

## Files to Create

### 1. `circuits/public_data_lib/` — shared Noir library

Extract from `circuits/spot_price/src/main.nr` (lines 1-72):
- `PublicDataLeafPreimage` struct + `hash()`
- `compute_public_data_tree_index(contract_addr, slot)` — silos with poseidon2, separator 23
- `derive_storage_slot_in_map(map_slot, key)` — `poseidon2([slot, key])`
- `verify_and_read_public_data(root, tree_index, preimage, witness_index, path)` — Merkle membership + indexed tree logic

`Nargo.toml`: `type = "lib"`, dep on `protocol_types`

### 2. `circuits/pnl_calculator/` — PnL circuit

```
global MAX_SWAPS: u32 = 4;

struct SwapData { block_number, token_in, token_out, amount_in, amount_out, is_exact_input }
struct PriceWitness { leaf_preimage, witness_index, witness_path[40] }

Inputs (private):
  price_feed_address, price_feed_assets_slot (=1),
  num_swaps,
  swaps[MAX_SWAPS], price_in_witnesses[MAX_SWAPS], price_out_witnesses[MAX_SWAPS],
  public_data_tree_roots[MAX_SWAPS],  // one per swap's block
  zero_hashes[3]                       // for merkle padding (log2(4) levels)

Outputs (public):
  (total_value_in, total_value_out, merkle_root, price_feed_address)

Logic per swap i < num_swaps:
  leaf = poseidon2([block_number, token_in, token_out, amount_in, amount_out, is_exact_input])
  price_in = verify_and_read(roots[i], derive_slot(assets_slot, token_in), witness_in[i])
  price_out = verify_and_read(roots[i], derive_slot(assets_slot, token_out), witness_out[i])
  assert(price_in != 0 && price_out != 0)
  total_value_in += amount_in * price_in
  total_value_out += amount_out * price_out
For i >= num_swaps: leaf = 0
Build merkle root from leaves + zero_hashes
```

`Nargo.toml`: `type = "bin"`, deps on `protocol_types` + `public_data_lib`

### 3. `src/pnl-prover.ts` — TS orchestrator

Follows `src/spot-price.ts` pattern:
- For each swap, fetch block header → `header.state.partial.publicDataTree.root`
- Derive PriceFeed slots: `poseidon2Hash([assetsSlot, tokenAddress])`
- Compute tree indices: `poseidon2HashWithSeparator([priceFeedAddr, derivedSlot], 23)`
- Fetch witnesses: `node.getPublicDataWitness(blockNumber, treeIndex)`
- Format witness: `{ slot, value, next_slot, next_index }` + `siblingPath.toFields()` + `witness.index`
- Pad unused swap slots with zeroes to MAX_SWAPS
- Precompute zero hashes via `getZeroHashes()` from `src/imt.ts`
- Returns `{ totalValueIn, totalValueOut, merkleRoot, priceFeedAddress, pnl }`

### 4. `test/pnl.test.ts` — integration test

1. Deploy PriceFeed: `PriceFeedContract.deploy(wallet).send().deployed()`
2. Set prices before swaps: `priceFeed.methods.set_price(token.address.toField(), priceU128)`
3. Deploy tokens + AMM, execute 2 swaps (reuse `swap-event.test.ts` setup pattern)
4. Run `SwapProver` + `SwapProofTree` → `treeResult.merkleRoot`
5. Run `PnlProver` with swap data → `pnlResult`
6. Assert `pnlResult.merkleRoot === treeResult.merkleRoot`
7. Assert PnL matches TS-computed: `sum(amount_out * price_out) - sum(amount_in * price_in)`

## Files to Modify

### 5. `circuits/spot_price/src/main.nr`
Replace inline helpers (lines 1-72) with `use dep::public_data_lib::{...}`

### 6. `circuits/spot_price/Nargo.toml`
Add `public_data_lib = { path = "../public_data_lib" }`

### 7. `scripts/postinstall.ts`
Add `pnl_calculator` compilation step

## Implementation Order

1. Create `circuits/public_data_lib/` + update `spot_price` to use it → `nargo compile` spot_price
2. Create `circuits/pnl_calculator/` → `nargo compile`
3. Create `src/pnl-prover.ts`
4. Create `test/pnl.test.ts`
5. Update `scripts/postinstall.ts`
6. Run: `bun test test/pnl.test.ts`

## Verification

1. `spot_price` and `pnl_calculator` both compile
2. E2E: set prices → 2 swaps → swap tree proof → PnL proof
3. Merkle roots match between swap tree and PnL proofs
4. PnL value matches TS expectation
