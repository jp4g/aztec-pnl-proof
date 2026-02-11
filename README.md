# PnL Proof

ZK proof of capital gains/losses from private AMM trading on Aztec, without revealing individual trades.

A user decrypts their private swap events, proves each swap's encrypted log matches on-chain data, computes FIFO cost basis PnL priced by a public oracle, and aggregates everything into a single recursive proof. The verifier learns the net PnL and which oracle was used, but nothing about individual swaps, token balances, or trading strategy.

## What the Proof Reveals

| Public Output | Description |
|---|---|
| `pnl` (i64) | Net realized PnL across all swaps (signed, can be gain or loss) |
| `root` | Merkle root of swap event leaf hashes (binds proof to on-chain logs) |
| `price_feed_address` | Oracle contract used for all price lookups |
| `block_number` | Latest block in the batch |
| `initial_lot_state_root` | Portfolio state before the batch |
| `remaining_lot_state_root` | Portfolio state after the batch |

## What Remains Hidden

- Individual swap amounts, tokens, and directions
- Number of swaps
- Token balances and portfolio composition
- Cost basis lots and trading strategy
- Wallet address / identity

---

## Architecture

```
    Encrypted Swap Events (on-chain AMM logs)
                    |
                    v
           +----------------+
           |   Decrypt &    |
           |  Parse Events  |
           +-------+--------+
                   |
                   v
    For each swap (chronological order):
    +--------------------------------------------+
    |         Individual Swap Circuit             |
    |                                             |
    |  1. Verify AES encryption                   |
    |  2. Hash ciphertext -> leaf                 |
    |  3. Read oracle prices (sell + buy token)   |
    |  4. FIFO consume sell lots -> PnL           |
    |  5. Add buy lot at oracle price             |
    |  6. Update lot state tree                   |
    +---------------------+----------------------+
                          |
                          v
    +--------------------------------------------+
    |         Summary Tree Circuit                |
    |         (recursive aggregation)             |
    |                                             |
    |  - Verify child proofs                      |
    |  - Hash leaves into merkle root             |
    |  - Sum signed PnL (i64)                     |
    |  - Enforce lot root chain continuity        |
    |  - Enforce chronological block ordering     |
    +---------------------+----------------------+
                          |
                          v
               +--------------------+
               |   Final Proof      |
               |                    |
               |  pnl: -141.47B    |
               |  root: 0x2f5f...  |
               |  oracle: 0x1f42.. |
               +--------------------+
```

---

## System Model

### Closed System Assumption

Tokens can only be minted (deposit), burned (withdraw), or swapped on an AMM. No peer-to-peer transfers. This means every token unit has a traceable cost basis origin: either a mint event or a swap acquisition.

### Multi-Token Portfolio Tracking

Unlike a per-token approach (which would require separate circuit runs per token), this system tracks **all tokens simultaneously** in a single lot state tree. Each swap updates two leaves: the sell-side token (FIFO consume) and the buy-side token (add new lot).

### FIFO Cost Basis

When selling a token, the oldest acquisition lots are consumed first (First In, First Out). Each lot records the amount and the oracle price at acquisition time. Realized PnL = `(sell_price - cost_basis) * amount` for each consumed lot.

---

## Lot State Tree

The portfolio is represented as a height-3 Merkle tree with 8 token slots. Each leaf commits to a token's lot array.

```
                    [root]
                   /      \
              [h01]        [h23]
             /    \       /    \
          [h0]   [h1]  [h2]   [h3]
          /  \   /  \  /  \   /  \
        L0  L1  L2  L3 L4  L5 L6  L7
        |   |   |   |  |   |  |   |
       ETH BTC DAI  .  .   .  .   .
```

Each leaf `Li` = `poseidon2_hash([token_address, num_lots, lot0.amount, lot0.cost, lot1.amount, lot1.cost, ...])` (66-field preimage: token + count + 32 lots x 2 fields each). Empty leaves are `0`.

**Per-swap update**: A swap touching tokens at leaves `Ls` (sell) and `Lb` (buy) produces:
1. Verify `Ls` against the **initial root** via sibling path
2. FIFO consume lots at `Ls`, compute new leaf hash
3. Compute **intermediate root** (tree after sell update)
4. Verify `Lb` against the **intermediate root** via sibling path
5. Add new lot at `Lb`, compute new leaf hash
6. Compute **final root** (tree after both updates)

```
  initial_root ----[sell FIFO]----> intermediate_root ----[buy add]----> final_root
       |                                                                    |
       v                                                                    v
  (public output:                                                 (public output:
   initial_lot_state_root)                                   remaining_lot_state_root)
```

---

## Individual Swap Circuit

Processes one swap event. All inputs are private.

### Inputs

```
plaintext:           [Field; 7]     // decrypted event fields
ciphertext:          [Field; 17]    // encrypted event as on-chain fields
ivsk_app:            Field          // recipient's app-siloed viewing key

block_number:        Field
initial_lot_state_root: Field       // lot tree root before this swap

sell_lots:           [Lot; 32]      // current lots for sell-side token
sell_num_lots:       u32
sell_leaf_index:     Field          // position in lot state tree
sell_sibling_path:   [Field; 3]     // merkle proof against initial root

buy_lots:            [Lot; 32]      // current lots for buy-side token
buy_num_lots:        u32
buy_leaf_index:      Field
buy_sibling_path:    [Field; 3]     // merkle proof against intermediate root

price_feed_address:  Field          // oracle contract
price_feed_assets_slot: Field       // storage slot for price map
public_data_tree_root: Field        // Aztec public data tree root at this block
sell_price_witness:  PriceWitness   // merkle proof for sell token price
buy_price_witness:   PriceWitness   // merkle proof for buy token price

previous_block_number: Field        // for chronological ordering
```

### Outputs (6 public values)

```
(
  leaf:                    Field   // poseidon2_hash(ciphertext, separator=0)
  pnl:                    i64     // signed realized PnL from sell-side FIFO
  remaining_lot_state_root: Field // lot tree root after this swap
  initial_lot_state_root:  Field  // lot tree root before this swap
  price_feed_address:      Field  // oracle used
  block_number:            Field  // block of this swap
)
```

### Circuit Logic

```
1. VERIFY ENCRYPTION
   Derive shared secret from ivsk_app + ephemeral PK (from ciphertext[0])
   Derive AES key/IV via Poseidon2
   Encrypt plaintext, compare against ciphertext bytes
   -> Proves plaintext matches the on-chain encrypted log

2. COMPUTE LEAF
   leaf = poseidon2_hash_with_separator(ciphertext, 0)
   -> Auditor can independently hash on-chain logs to verify

3. EXTRACT SWAP DATA
   token_in  = plaintext[2]    // sold token address
   token_out = plaintext[3]    // bought token address
   amount_in = plaintext[4]    // amount sold
   amount_out = plaintext[5]   // amount received

4. ASSERT CHRONOLOGICAL ORDER
   block_number >= previous_block_number

5. SELL SIDE (FIFO consume + PnL)
   Verify sell lots against initial_lot_state_root
   Read sell_price from oracle via public data tree proof
   For each lot (oldest first):
     consumed = min(remaining, lot.amount)
     pnl += consumed * (sell_price - lot.cost_per_unit)
     lot.amount -= consumed
   Assert all sell amount consumed
   Compact lots (remove empty, shift forward)
   Compute intermediate_root with updated sell leaf

6. BUY SIDE (add lot)
   Verify buy lots against intermediate_root
   Read buy_price from oracle
   Append new lot: { amount: amount_out, cost_per_unit: buy_price }
   Compute final_root with updated buy leaf
```

---

## Summary Tree Circuit

Recursively combines pairs of proofs (individual or summary) into a single proof. Handles odd counts by padding with a zero hash.

```
                         [Final Proof]
                        /             \
                [Summary L2]      [Summary L2]
               /           \          |
        [Summary L1]  [Summary L1]  [Swap 5+6]
        /       \       /       \
   [Swap 1+2] [Swap 3+4] ...
```

### Per-pair logic

```
1. Verify left proof  (always present)
2. Verify right proof (if present, else pad with zero hash)
3. root = poseidon2_hash([left.root, right.root])
4. total_pnl = left.pnl + right.pnl          (i64 signed addition)
5. Assert left.remaining_lots == right.initial_lots  (lot chain)
6. Assert left.block <= right.block            (chronological)
7. Assert same price_feed_address
8. Assert vkey is either leaf_vkey or summary_vkey
```

### Outputs (same 6-value shape)

```
(
  root:                    Field   // merkle root of all swap leaves
  total_pnl:               i64    // sum of all individual PnLs
  remaining_lot_state_root: Field  // rightmost child's remaining root
  initial_lot_state_root:   Field  // leftmost child's initial root
  price_feed_address:       Field  // shared oracle
  block_number:             Field  // max block (rightmost child)
)
```

---

## Ciphertext Verification

The circuit takes the encrypted swap event exactly as it appears on-chain: 17 Field elements (1 ephemeral PK x-coordinate + 16 ciphertext body fields).

```
On-chain encrypted log:
  [eph_pk_x | ct_field_0 | ct_field_1 | ... | ct_field_15]
       1          16 fields (31 bytes each)

Circuit flow:
  1. Extract eph_pk_x, reconstruct ephemeral public key point
  2. ECDH shared secret = ivsk_app * eph_pk
  3. Derive AES-128 key + IV from shared secret (Poseidon2)
  4. Convert plaintext fields -> bytes (32 bytes/field)
  5. Convert ciphertext fields -> bytes (31 bytes/field, skip high byte)
  6. AES-128 encrypt plaintext bytes
  7. Assert encrypted bytes match ciphertext bytes

Leaf hash:
  leaf = poseidon2_hash_with_separator(all 17 ciphertext fields, 0)
```

The leaf hash uses the **ciphertext fields** (not plaintext), so an auditor who can see the on-chain encrypted logs can independently verify which events were included in the proof by hashing the logs and checking against the merkle root.

---

## PnL Computation

### Signed i64 Arithmetic

All PnL computation uses Noir's native `i64` type. This safely handles negative values (losses) without Field underflow.

```
For each consumed lot:
  realized = consumed_amount * (sell_price - cost_per_unit)
  // positive = gain, negative = loss

Total PnL = sum of all realized values across all swaps
```

The circuit outputs `pub i64`, which Noir encodes as a two's complement 64-bit value in the proof's public inputs. The TypeScript side handles encoding/decoding:

```
Noir output:  -150000000000  ->  proof field: 18446744073559551616  (2^64 - 150B)
Decode:       if field >= 2^63, then value = field - 2^64
```

### Price Precision

Oracle prices are read from the PriceFeed contract's public storage via Merkle membership proofs against the Aztec public data tree. Prices must fit in i64 when multiplied by amounts (~9.2 * 10^18 max).

---

## Lot State Continuity

Sequential proofs are chained via lot state tree roots:

```
Swap 1              Swap 2              Swap 3
+--------+          +--------+          +--------+
| init:  |  root_1  | init:  |  root_2  | init:  |
| root_0 |--------->| root_1 |--------->| root_2 |
| remain:|          | remain:|          | remain:|
| root_1 |          | root_2 |          | root_3 |
+--------+          +--------+          +--------+

Summary tree enforces:
  swap[N].remaining_lot_state_root == swap[N+1].initial_lot_state_root
```

The first proof's `initial_lot_state_root` represents the starting portfolio (empty for a fresh start, or carried from a previous batch). The final proof's `remaining_lot_state_root` is the ending portfolio state.

---

## Privacy Analysis

| Data Point | Revealed? | Notes |
|---|---|---|
| Net PnL (signed) | Yes | The whole point |
| Oracle contract address | Yes | Verifier can assess trust |
| Swap merkle root | Yes | Commits to the swap set |
| Block range | Yes | First and last block numbers |
| Lot state roots | Yes | Opaque hashes, reveal nothing about contents |
| Number of swaps | No | Uniform proof structure |
| Individual trade amounts | No | Private inputs |
| Token addresses | No | Private inputs |
| Trading direction per swap | No | Private |
| Cost basis / lot contents | No | Only hashes are public |
| Portfolio composition | No | Lot tree leaves are private |

### Trust Assumptions

- **Oracle correctness**: Proof assumes PriceFeed prices are accurate. The oracle address is public so the verifier can assess trust.
- **Completeness**: The proof covers a specific swap set (committed via merkle root). It does not prove these are ALL the user's swaps. Completeness enforcement requires out-of-band mechanisms (e.g., AMM contract committing per-user swap sets).

---

## Project Structure

```
circuits/
  individual_swap/       Per-swap proof (encryption, FIFO, oracle, lot tree)
  swap_summary_tree/     Recursive aggregation circuit

src/
  swap-prover.ts         Orchestrates individual swap proofs
  swap-proof-tree.ts     Recursive proof aggregation
  lot-state-tree.ts      TypeScript lot state tree management
  decrypt.ts             AES decryption of swap events
  event-reader.ts        Discovers encrypted swap events via tags
  rebalance.ts           Pool rebalancing utility (for tests)

test/
  pnl.test.ts            E2E: 3 tokens, 3 pools, 6 swaps, price changes, full proof

contracts/
  amm_contract/          AMM contract (constant-product with private swap events)
  token_contract/        Token contract
```

## Running

Requires a running local Aztec network.

```sh
bun install
aztec start --sandbox    # separate terminal
bun test test/pnl.test.ts
```
