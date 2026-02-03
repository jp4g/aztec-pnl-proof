# Auditor Tag Siloing Issue - Diagnostic Report

**Date:** 2026-02-03
**Issue:** Auditor retrieving 0 encrypted notes despite transactions being sent successfully

## Problem Summary

The auditor's `retrieveEncryptedNotes()` function is generating tags but receiving 0 logs from `node.getLogsByTags()`, even though:
- Transactions were sent and confirmed with `.wait()`
- The PXE successfully synced the notes
- 10 private token transfers occurred between addresses[1] and addresses[2]

## Root Cause: Missing Tag Siloing

### What the PXE Does (CORRECT)

From `/yarn-project/pxe/src/contract_function_simulator/pxe_oracle_interface.ts:468`:

```typescript
// PXE generates tags in TWO steps:
const tagsForTheWholeWindow = await Promise.all(
  preTagsForTheWholeWindow.map(async preTag => {
    // Step 1: Generate base tag
    const baseTag = await Tag.compute(preTag);

    // Step 2: Silo with contract address
    return SiloedTag.compute(baseTag, contractAddress);
  }),
);

// Then queries with siloed tags
const tagsForTheWholeWindowAsFr = tagsForTheWholeWindow.map(tag => tag.value);
const logsByTags = await this.#getPrivateLogsByTags(tagsForTheWholeWindowAsFr);
```

**Two-step process:**
1. `Tag.compute({secret, index})` → generates: `poseidon2Hash([secret.value, index])`
2. `SiloedTag.compute(tag, contractAddress)` → silos the tag with the contract address

### What Our Auditor Does (WRONG)

From `/volume-proof/src/auditor.ts:82`:

```typescript
// We only do Step 1:
const tags = await TagGenerator.generateTags(secretEntry.secret, index, count);

// TagGenerator.generateTags() only computes:
//   poseidon2Hash([secret.value, index])

// We're missing the siloing step!
const logsPerTag = await node.getLogsByTags(tags);  // Returns 0 logs!
```

## Why This Matters

- The Aztec node stores logs with **siloed tags**
- Siloing prevents tag collision across different contracts
- Querying with unsiloed tags returns 0 results because no logs match

## The Fix

The auditor needs to add the siloing step:

```typescript
// Current (broken):
const tags = await TagGenerator.generateTags(secretEntry.secret, index, count);

// Fixed:
const baseTags = await TagGenerator.generateTags(secretEntry.secret, index, count);
const siloedTags = await Promise.all(
  baseTags.map(tag => SiloedTag.compute(tag, secretEntry.app))
);
```

## Implementation Details

### Required Classes

- `Tag` class: Located in `@aztec/stdlib/logs` or `@aztec/pxe/src/tagging`
- `SiloedTag` class: Located in `@aztec/stdlib/logs` or `@aztec/pxe/src/tagging`

### Tag Computation Formula

```typescript
// Step 1: Base tag
baseTag = poseidon2Hash([secret.value, index])

// Step 2: Siloed tag
siloedTag = poseidon2Hash([baseTag, contractAddress])
```

## Test Evidence

Debug output from failed test run:

```
=== STEP 1: Exporting Tagging Secrets ===
Exported tagging secrets: 2 secrets
  Secret: inbound - counterparty: 0x08cad1e0367694... app: 0x205c372d1d4c59...
    Secret value: 0x144e1c7af4fad67211381e8d34f0189ba3ebb11c1b789bcc658f32d16d65e6f2
  Secret: outbound - counterparty: 0x08cad1e0367694... app: 0x205c372d1d4c59...
    Secret value: 0x2071748ae90c3b35bdafc5d2c404371d517a487d2e6e80dc090fbaba1fb9b3a6

=== STEP 2: Retrieving Encrypted Notes ===
[DEBUG] Processing secret: inbound - counterparty: 0x08cad1e0367694...
[DEBUG] Generated 50 tags for indices 0-49
[DEBUG] First tag: 0x1dedec1f1be9de580ab85c66cf73f471a3ad30e85c4c81bacde39e8fd940c89d
[DEBUG] Received 0 logs from node  <-- PROBLEM: Should find logs!

[DEBUG] Processing secret: outbound - counterparty: 0x08cad1e0367694...
[DEBUG] Generated 50 tags for indices 0-49
[DEBUG] First tag: 0x16b3a0a504bcf5f44223c40358334c6e28eee21aa91f525139cb5a7e9ac645e6
[DEBUG] Received 0 logs from node  <-- PROBLEM: Should find logs!

=== RETRIEVAL RESULTS ===
Total Notes: 0  <-- Expected: 10 notes (5 inbound + 5 outbound)
Total Transactions: 0
```

## Key PXE Code References

**Main syncing logic:**
`/yarn-project/pxe/src/contract_function_simulator/pxe_oracle_interface.ts`
- Line 338-401: `syncTaggedLogsAsSender()` - outbound log syncing
- Line 412-567: `syncTaggedLogs()` - inbound log syncing
- Line 468: **Critical line showing siloed tag generation**
- Line 1019-1022: `#getPrivateLogsByTags()` - filters to private logs only

**Tag utilities:**
`/yarn-project/pxe/src/tagging/utils.ts`
- Tag window generation helpers

**Private log filtering:**
```typescript
async #getPrivateLogsByTags(tags: Fr[]): Promise<TxScopedL2Log[][]> {
  const allLogs = await this.aztecNode.getLogsByTags(tags);
  return allLogs.map(logs => logs.filter(log => !log.isFromPublic));
}
```

## Next Steps

1. Import `SiloedTag` and `Tag` classes into auditor
2. Modify `processSecret()` to silo tags before querying
3. Re-run test to verify logs are retrieved
4. Verify ciphertexts are correctly extracted

## Notes

- The PXE uses the exact same `aztecNode.getLogsByTags()` API we're using
- The difference is purely in tag generation (siloed vs unsiloed)
- This is a deterministic computation issue, not a timing/sync issue
