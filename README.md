# Aztec PNL Proof

ZK proofs over Aztec protocol state for selective disclosure of financial activity.

## Circuits

### Spot Price (`circuits/spot_price/`)
Proves the spot price of a constant-product AMM at a historical block by verifying the AMM's public token balances via Merkle membership in the public data tree.

**Public outputs:** price, block number, public data tree root, AMM address, token0 address, token1 address

### Note Creation (`circuits/note_creation/`)
Proves a private note was created after a specific block, exists at a later block, and has not been nullified. Uses note hash tree inclusion, append-only non-inclusion, and nullifier indexed tree gap proofs.

**Public outputs:** note value, before block number, inclusion block number, contract address, note hash tree root, nullifier tree root

## Project Structure

```
circuits/          Noir circuits (each with Nargo.toml + src/main.nr)
src/               TypeScript orchestrators (witness fetching + proof generation)
test/              E2E tests (require a running local Aztec node)
```

## Running

Requires `aztec:v3.0.0-devnet.patch-6`, `nargo:1.0.0-beta.18`, and a local fork of `aztec-packages`.

```sh
yarn install
aztec start --local-network   # in a separate terminal
bun test test/
```
