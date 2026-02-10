# Tax Proof Architecture: FIFO Capital Gains on Private AMM Swaps

## Overview

A ZK proof system that computes **net PnL (profit and loss)** from private AMM trading activity on Aztec. The prover demonstrates to a verifier (e.g., a tax authority) their net trading gains or losses, without revealing individual trade details, token balances, or trading strategy.

**What the proof reveals:**
- Net PnL (signed: can be positive gain or negative loss)
- Which price oracle was used
- A merkle root committing to the underlying swap set

**What remains hidden:**
- Individual swap amounts, tokens, and directions
- Number of swaps (uniform proof structure)
- Token balances and portfolio composition
- Cost basis lots and trading strategy

---

## System Model

### Assumptions

```
+-----------------------------------------------------+
|                   CLOSED SYSTEM                      |
|                                                      |
|   Tokens can ONLY:                                   |
|     1. Be minted    (deposit fiat -> token)          |
|     2. Be burned    (token -> withdraw fiat)         |
|     3. Be swapped   (token A -> token B on AMM)     |
|                                                      |
|   No external transfers between users.               |
|   Every token unit has a traceable origin.            |
+-----------------------------------------------------+
```

This means every token's **cost basis** can be traced back to either:
- A mint event (deposit), where cost basis = oracle price at mint time
- A swap acquisition, where cost basis = oracle price at swap time

### Per-Token Tracking

Each circuit instance tracks **one token** (e.g., wETH). The oracle provides a USD-equivalent price for every token, so the circuit does not need to know what the counterpart token in a swap is.

- For N tokens, run N circuit instances (one per token)
- Each instance processes all swaps where that token appears as either `token_in` or `token_out`
- The counterpart token is irrelevant -- only the tracked token's oracle price matters

```
Example with 4 tokens: USDC, wETH, wZEC, wAZTEC
AMM pools: wETH/USDC, wZEC/USDC, wAZTEC/USDC, wZEC/wETH, wAZTEC/wETH

  Circuit 1: tracks wETH lots
    - wETH/USDC swaps (buy or sell wETH)
    - wZEC/wETH swaps (buy or sell wETH)
    - wAZTEC/wETH swaps (buy or sell wETH)

  Circuit 2: tracks wZEC lots
    - wZEC/USDC swaps (buy or sell wZEC)
    - wZEC/wETH swaps (buy or sell wZEC)

  Circuit 3: tracks wAZTEC lots
    - wAZTEC/USDC swaps (buy or sell wAZTEC)
    - wAZTEC/wETH swaps (buy or sell wAZTEC)

  USDC: no circuit needed (it IS the unit of account, cost basis = $1)
```

### Why no "denom" address?

A user can swap wETH for wZEC directly (on a wZEC/wETH pool). This swap:
- Is a **sell** of wETH (for the wETH circuit) -- consumes wETH lots, may realize gains
- Is a **buy** of wZEC (for the wZEC circuit) -- creates a new wZEC lot

The oracle price of the tracked token determines the USD value in both cases. The counterpart token does not matter for the capital gains calculation because the oracle independently prices every asset.

---

## Architecture

```
                          Encrypted Swap Events (from AMM contracts)
                                        |
                                        v
                               +------------------+
                               |    Decrypt &     |
                               | Route by Token   |
                               +--------+---------+
                                        |
                    +-------------------+-------------------+
                    v                   v                   v
            +--------------+   +--------------+   +--------------+
            |  wETH swaps  |   |  wZEC swaps  |   |  ...         |
            |  (all pools) |   |  (all pools) |   |              |
            +--------------+   +--------------+   +--------------+
                    |                  |                   |
                    v                  v                   v
            +--------------+   +--------------+   +--------------+
            |  Tax Circuit |   |  Tax Circuit |   |              |
            |  (per swap)  |   |  (per swap)  |   |              |
            |              |   |              |   |              |
            | - Verify AES |   | - Verify AES |   |              |
            | - FIFO lots  |   | - FIFO lots  |   |              |
            | - Oracle     |   | - Oracle     |   |              |
            |   price      |   |   price      |   |              |
            | - i64 PnL    |   | - i64 PnL    |   |              |
            +------+-------+   +------+-------+   +------+-------+
                   |                  |                   |
                   v                  v                   v
            +------------------------------------------------------+
            |              Summary Tree (recursive)                 |
            |                                                       |
            |   Aggregates proofs across sequential swaps.          |
            |   Always wraps for uniform proof structure.            |
            |   Sums signed PnL (magnitude + sign) across proofs.  |
            |   Verifies lot hash continuity between proofs.        |
            +-------------------------+----------------------------+
                                      |
                                      v
                            +-------------------+
                            |   Final Output    |
                            |                   |
                            |  net_pnl (signed) |
                            |  swap_merkle_root |
                            |  oracle_address   |
                            +-------------------+
```

---

## Numeric Representation

### i64 Arithmetic

All PnL computation uses **i64** (signed 64-bit integer) to safely handle negative values (losses). Field elements are unsigned and would underflow on subtraction, so gains/losses are computed in i64 and encoded as `(magnitude, is_negative)` for Field output.

### Price Precision

Oracle prices use at most **4 decimal places** (scaled by 10^4). This ensures `amount * price` products fit in i64:

```
i64 max = 9,223,372,036,854,775,807 (~9.2 * 10^18)

Example worst case:
  1000 BTC (amount in 4-decimal: 10,000,000)
  * $25,000,000 (price in 4-decimal: 250,000,000,000)
  = 2.5 * 10^18  -->  fits in i64

Overflow threshold: ~$92 quadrillion per lot-price product
```

Token amounts must also fit in i64 when cast from Field. The `as i64` cast in the circuit acts as an implicit range check -- if a value exceeds i64 max, proof generation fails.

### Casting Chain

Noir does not allow direct `i64 -> Field` casts. The circuit uses:
- **Field -> i64**: `amount_in as i64` (range-checked by Noir)
- **i64 -> Field**: `value as u64 as Field` (go through unsigned intermediate)

---

## Tax Calculation Model

### FIFO Cost Basis

**FIFO** (First In, First Out): when you sell TOKEN, you consume your oldest acquisition lots first.

Each **buy** creates a new lot:
```
Lot = { amount: Field, cost_per_unit: Field }
```

Each **sell** consumes lots from the front of the queue:
```
For a sell of S units at oracle price P (using i64 arithmetic):
    remaining = S as i64
    pnl: i64 = 0
    while remaining > 0:
        lot = oldest unconsumed lot
        consumed = min(remaining, lot.amount)
        proceeds = consumed * P
        cost = consumed * lot.cost_per_unit
        pnl += proceeds - cost        // signed! can be negative
        lot.amount -= consumed
        remaining -= consumed
    // After sell, compact lots (remove empty, shift to front)
```

### What is a "Buy" vs "Sell"?

For a tracked token (e.g., wETH):
- **Buy**: `token_out == token_address`. You acquired the tracked token. The counterpart could be any token (USDC, wZEC, etc.). Creates a new lot with `cost_per_unit = oracle_price` of the tracked token at that block.
- **Sell**: `token_in == token_address`. You disposed of the tracked token. Consumes lots FIFO and produces signed PnL.

The circuit determines direction by checking which side of the swap matches `token_address`. It does not need to know what the other token is.

### Lot Compaction

After a sell, fully consumed lots (amount = 0) are removed and remaining lots shift to the front of the array. This ensures `num_lots` accurately reflects active positions, allowing slots to be reused for future buys. MAX_LOTS = 8 concurrent open positions.

---

## Worked Example

**Tracked token**: wETH. Oracle prices from PriceFeed at each block.

### Swap Sequence

| # | Block | Swap | Direction | Amount wETH | Oracle wETH Price |
|---|-------|------|-----------|-------------|-------------------|
| 1 | 100   | USDC -> wETH | Buy wETH  | 2.0 out | $1000 |
| 2 | 200   | wZEC -> wETH | Buy wETH  | 1.0 out | $2500 |
| 3 | 300   | wETH -> USDC | Sell wETH | 1.5 in  | $4000 |
| 4 | 400   | wETH -> wZEC | Sell wETH | 1.0 in  | $500  |

Note: swap 4 sells at a loss ($500 < $1000 cost basis).

### Lot Tracking (FIFO)

**After swap 1** (Buy 2 wETH, oracle price $1000):
```
Lots: [ {amount: 2.0, cost: $1000} ]
PnL: 0 (buy, no realization)
```

**After swap 2** (Buy 1 wETH via wZEC, oracle price $2500):
```
Lots: [ {amount: 2.0, cost: $1000}, {amount: 1.0, cost: $2500} ]
PnL: 0 (buy, no realization)
```

**Swap 3** (Sell 1.5 wETH for USDC, oracle price $4000):
```
Consume from lot 1: 1.5 wETH
  pnl = 1.5 * ($4000 - $1000) = +$4500

Lots after: [ {amount: 0.5, cost: $1000}, {amount: 1.0, cost: $2500} ]
Running PnL: +$4500
```

**Swap 4** (Sell 1.0 wETH for wZEC, oracle price $500):
```
Consume from lot 1: 0.5 wETH (remaining)
  pnl = 0.5 * ($500 - $1000) = -$250   <-- LOSS

Consume from lot 2: 0.5 wETH
  pnl = 0.5 * ($500 - $2500) = -$1000  <-- LOSS

Lots after (compacted): [ {amount: 0.5, cost: $2500} ]
Running PnL: +$4500 + (-$250) + (-$1000) = +$3250
```

### Final Output

```
Net PnL: +$3250
PnL magnitude: 3250, is_negative: 0
Remaining lots: [ {amount: 0.5, cost: $2500} ]  <-- carried to next proof
```

---

## Circuit Design

### Individual Swap Circuit

Processes **one swap** involving the tracked token.

#### Inputs (all private)

```
// Swap event (encrypted)
plaintext_bytes:       [u8; 224]                        // decrypted event bytes
eph_pk_x:              Field                            // ephemeral public key x
ciphertext_bytes:      [u8; 496]                        // encrypted event bytes
ivsk_app:              Field                            // recipient viewing key
block_number:          Field                            // block of swap

// Token identification
token_address:         Field                            // the token we're tracking

// Oracle price data (only for the tracked token)
price_feed_address:    Field
price_feed_assets_slot: Field
public_data_tree_root: Field                            // public data root at swap block
price_witness:         PriceWitness                     // merkle proof for token price

// FIFO lot state carried from previous proof
initial_lots:          [Lot; 8]                         // lots from previous proof
initial_num_lots:      u32                              // how many lots are active
```

#### Outputs (6 public Fields)

```
(
  leaf_hash,              // poseidon2 hash of swap data
  pnl,                    // absolute value of realized PnL (0 for buys)
  pnl_is_negative,        // 0 = gain or zero, 1 = loss
  remaining_lots_hash,    // hash of FIFO lots after this swap
  initial_lots_hash,      // hash of FIFO lots received (for chaining)
  price_feed_address      // which oracle was used
)
```

#### Circuit Logic (pseudocode)

```noir
// 1. Verify encryption (proves swap event is authentic)
verify_encryption(plaintext_bytes, eph_pk_x, ciphertext_bytes, ivsk_app);

// 2. Extract swap values
let token_in  = extract_field(plaintext_bytes, 2);
let token_out = extract_field(plaintext_bytes, 3);
let amount_in = extract_field(plaintext_bytes, 4);
let amount_out = extract_field(plaintext_bytes, 5);
let is_exact_input = extract_field(plaintext_bytes, 6);

// 3. Compute leaf hash
let leaf = poseidon2_hash([block_number, token_in, token_out,
                           amount_in, amount_out, is_exact_input]);

// 4. Determine direction
let is_buy  = (token_out == token_address);
let is_sell = (token_in == token_address);
assert(is_buy | is_sell, "Swap does not involve tracked token");

// 5. Read oracle price for tracked token at this block
let token_price = verify_and_read_public_data(...);

// 6. Hash initial lots (for chaining verification)
let initial_lots_hash = hash_lots(initial_lots, initial_num_lots);

// 7. Process swap using i64 arithmetic
let mut lots = initial_lots;
let mut num_lots = initial_num_lots;
let mut pnl: i64 = 0;

if is_buy {
    lots[num_lots] = Lot { amount: amount_out, cost_per_unit: token_price };
    num_lots += 1;
} else {
    let sell_price: i64 = token_price as i64;
    let mut remaining: i64 = amount_in as i64;

    for j in 0..MAX_LOTS {
        let lot_amount: i64 = lots[j].amount as i64;
        let lot_cost: i64 = lots[j].cost_per_unit as i64;
        if (remaining != 0) & (lot_amount != 0) {
            let consumed = if remaining < lot_amount { remaining } else { lot_amount };
            pnl += consumed * sell_price - consumed * lot_cost;  // signed!
            lots[j].amount = (lot_amount - consumed) as u64 as Field;
            remaining -= consumed;
        }
    }
    assert(remaining == 0);
    // Compact lots (remove empty, shift to front)
}

// 8. Hash remaining lots
let remaining_lots_hash = hash_lots(lots, num_lots);

// 9. Encode signed PnL
let pnl_is_negative = if pnl < 0 { 1 } else { 0 };
let pnl_abs = if pnl < 0 { (-pnl) as u64 as Field } else { pnl as u64 as Field };

return (leaf, pnl_abs, pnl_is_negative,
        remaining_lots_hash, initial_lots_hash, price_feed_address);
```

### Summary Tree Circuit

Recursively aggregates individual swap proofs into a single proof:

```
                    +-------------+
                    |  Summary    |
                    |   Root      |
                    +------+------+
                     +-----+-----+
                +----+---+  +----+---+
                |Proof 1 |  |Proof 2 |
                |(1 swap |  |(1 swap |
                | proof) |  | proof) |
                +--------+  +--------+
```

#### Public inputs per child (6 Fields)

```
[0] leaf_or_root         // leaf hash (individual) or merkle root (summary)
[1] pnl                  // absolute PnL value
[2] pnl_is_negative      // 0 or 1
[3] remaining_lots_hash  // lot state after this proof
[4] initial_lots_hash    // lot state before this proof
[5] price_feed_address
```

#### Summary tree logic

The summary tree:
1. **Verifies** each child proof recursively
2. **Hashes** sub-roots into a higher-level merkle root: `root = poseidon2([left_node, right_node])`
3. **Sums signed PnL** across children using i64:
   - Convert each child's `(pnl, is_negative)` to i64
   - Sum them: `total = left_pnl_signed + right_pnl_signed`
   - Re-encode as `(magnitude, is_negative)` for output
4. **Verifies lot hash chain**: left child's `remaining_lots_hash == right child's `initial_lots_hash`
5. **Passes through** `price_feed_address` (asserts both children use the same oracle)

#### Summary tree outputs (6 Fields)

```
(
  root,                   // merkle root combining child roots
  total_pnl,              // absolute value of summed PnL
  total_pnl_is_negative,  // 0 or 1
  remaining_lots_hash,    // right child's remaining_lots_hash (end of chain)
  initial_lots_hash,      // left child's initial_lots_hash (start of chain)
  price_feed_address      // oracle used
)
```

---

## Lot State Continuity

Sequential proofs are chained via lot hashes:

```
+----------+     lots_hash_0     +----------+     lots_hash_1     +----------+
| Proof 0  | -----------------> | Proof 1  | -----------------> | Proof 2  |
|          |  (remaining lots   |          |  (remaining lots   |          |
| initial: |   from proof 0)   | initial: |   from proof 1)   | initial: |
| empty    |                    | lots_0   |                    | lots_1   |
+----------+                    +----------+                    +----------+

Each proof outputs:
  - initial_lots_hash  (what it received)
  - remaining_lots_hash (what it passes forward)

Chaining rule (enforced by summary tree):
  proof[N].remaining_lots_hash == proof[N+1].initial_lots_hash
```

The **summary tree** checks that:
1. Left child's `remaining_lots_hash` equals right child's `initial_lots_hash`
2. This forms an unbroken chain proving all lots were processed in order
3. The first proof's `initial_lots_hash` should correspond to an empty lot set (fresh start)

### Why hash the lots?

Lots are private data (they reveal cost basis, which reveals trading history). Only the **hash** is public, enabling chain verification without revealing lot contents. The prover knows the lots; the verifier only sees that they connect.

---

## TypeScript Orchestrator

### Flow

```typescript
async function proveTax(
    allEvents: SwapEvent[],
    tokenAddress: Fr,
    priceFeedAddress: Fr,
    priceFeedAssetsSlot: Fr,
): Promise<TaxProofResult> {

    // 1. Filter swaps involving this token and sort by block
    const tokenSwaps = allEvents
        .filter(e => e.tokenIn === tokenAddress || e.tokenOut === tokenAddress)
        .sort((a, b) => a.blockNumber - b.blockNumber);

    // 2. Prove each swap sequentially, chaining lot state
    let currentLots: Lot[] = [];
    const swapProofs = [];

    for (const swap of tokenSwaps) {
        const result = await swapProver.prove(
            swap,
            currentLots,
            tokenAddress,
            priceFeedAddress,
            priceFeedAssetsSlot,
        );
        swapProofs.push(result);
        currentLots = result.remainingLots; // carry forward
    }

    // 3. Aggregate via summary tree (always, for privacy)
    const finalProof = await summaryTree.prove(swapProofs);

    return {
        proof: finalProof.proof,
        pnl: finalProof.pnl,           // signed bigint
        merkleRoot: finalProof.merkleRoot,
    };
}
```

### Preparing Lot Inputs

For proof 0, `initial_lots` is all zeros and `initial_num_lots = 0`.

For proof N > 0, `initial_lots` and `initial_num_lots` come from the prover's local state (the lot data after the previous proof). The circuit verifies continuity via the `initial_lots_hash` / `remaining_lots_hash` chain.

---

## Privacy Analysis

### What the Verifier Learns

| Data Point | Revealed? | Notes |
|---|---|---|
| Net PnL (gain or loss) | Yes | Public output (signed) |
| Price oracle used | Yes | Public output (address) |
| Swap merkle root | Yes | Commits to swap set |
| Number of swaps | No | Uniform proof structure via summary tree |
| Individual trade amounts | No | Hidden inside proof |
| Token addresses traded | No | Private circuit inputs |
| Trading direction (buy/sell) | No | Private |
| Cost basis / lot state | No | Only hash is public |
| Wallet address / identity | No | Only viewing key used |
| Counterpart tokens | No | Circuit only reads tracked token price |

### Uniform Proof Structure

All proofs are wrapped in the summary tree regardless of swap count. A proof covering 3 swaps looks identical (same verification key, same public input structure) to one covering 47 swaps. The verifier cannot distinguish them.

### Trust Assumptions

- **Oracle correctness**: The proof assumes PriceFeed oracle prices are accurate. A malicious oracle could produce incorrect tax calculations. The oracle address is a public output so the verifier can assess trust.
- **Completeness**: The proof covers a specific set of swaps (committed via merkle root). It does NOT prove these are ALL the user's swaps. The user could omit swaps to reduce their tax. This requires out-of-band enforcement (e.g., the AMM contract commits to per-user swap sets that the proof must match).

---

## Comparison to Previous Implementation

### What Existed (individual_swap_old)

```
individual_swap circuit (batch of 8):
  - Verifies encrypted swap events
  - Reads oracle prices per swap (both token_in and token_out)
  - Computes value_in = amount_in * price_in
  - Computes value_out = amount_out * price_out
  - Builds 8-leaf merkle tree
  - Outputs: (root, 0, total_value_in, total_value_out, price_feed_address)
```

**Problem**: `total_value_in` and `total_value_out` price each swap at its own block's oracle price. This measures execution quality (slippage/fees), not capital gains.

### What Changed

| Component | Old | New |
|---|---|---|
| Batch size | 8 swaps per circuit | 1 swap per circuit |
| Per-swap pricing | Both token prices from oracle | Only tracked token price |
| Arithmetic | Field (unsigned) | i64 (signed) for PnL |
| Cost basis | None | FIFO lot tracking |
| Gain computation | `value_out - value_in` (unsigned, meaningless) | `proceeds - cost_basis` per FIFO lot (signed, real PnL) |
| Output values | `total_value_in`, `total_value_out` | `pnl_abs`, `pnl_is_negative` + lot hashes |
| Output count | 5 Fields | 6 Fields |
| Lot state | None | `initial_lots_hash`, `remaining_lots_hash` for chaining |
| Lot compaction | N/A | After sells, empty lots removed, remaining shift to front |
| Token awareness | None (processes any swap) | Per-token (checks `token_address` match) |
| Direction detection | None | `token_out == token_address` = buy, `token_in == token_address` = sell |
| Counterpart token | Both prices needed | Irrelevant (only tracked token price matters) |
| Price constraint | None | 4-decimal precision, fits in i64 |
