import type { Fr } from '@aztec/foundation/curves/bn254';
import type { Logger } from '@aztec/foundation/log';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import type { TxScopedL2Log } from '@aztec/stdlib/logs';
import type { IndexedTxEffect, TxEffect, TxHash } from '@aztec/stdlib/tx';

import type { NoteDirection, NoteHashMapping } from './types';

/**
 * Maps discovered logs to their corresponding note hashes.
 *
 * The key insight is that the logIndexInTx corresponds to the index
 * of the note hash in the TxEffect.noteHashes array.
 */
export class NoteMapper {
  private txEffectCache: Map<string, IndexedTxEffect> = new Map();

  constructor(
    private node: AztecNode,
    private log?: Logger,
  ) {}

  async mapLogsToNoteHashes(
    logs: TxScopedL2Log[],
    direction: NoteDirection,
    counterparty: AztecAddress,
    app: AztecAddress,
  ): Promise<NoteHashMapping[]> {
    const mappings: NoteHashMapping[] = [];

    const logsByTx = this.groupLogsByTx(logs);

    for (const [txHashStr, txLogs] of logsByTx) {
      const txHash = txLogs[0].txHash;
      const indexedTxEffect = await this.getTxEffect(txHash);

      if (!indexedTxEffect) {
        this.log?.warn(`TxEffect not found for tx ${txHashStr}, skipping ${txLogs.length} logs`);
        continue;
      }

      const txEffect = indexedTxEffect.data;

      for (const log of txLogs) {
        const noteHash = this.extractNoteHash(txEffect, log);
        if (noteHash) {
          mappings.push({
            txHash: log.txHash,
            blockNumber: log.blockNumber,
            logIndexInTx: log.logIndexInTx,
            noteHash,
            dataStartIndexForTx: log.dataStartIndexForTx,
            direction,
            counterparty,
            app,
            encryptedLog: log.log.toBuffer(),
          });
        } else {
          this.log?.warn(
            `Could not extract note hash for log at index ${log.logIndexInTx} in tx ${txHashStr}. ` +
              `TxEffect has ${txEffect.noteHashes.length} note hashes.`,
          );
        }
      }
    }

    return mappings;
  }

  private extractNoteHash(txEffect: TxEffect, log: TxScopedL2Log): Fr | undefined {
    if (log.logIndexInTx >= txEffect.noteHashes.length) {
      return undefined;
    }
    return txEffect.noteHashes[log.logIndexInTx];
  }

  private groupLogsByTx(logs: TxScopedL2Log[]): Map<string, TxScopedL2Log[]> {
    const grouped = new Map<string, TxScopedL2Log[]>();

    for (const log of logs) {
      const key = log.txHash.toString();
      const existing = grouped.get(key) ?? [];
      existing.push(log);
      grouped.set(key, existing);
    }

    return grouped;
  }

  private async getTxEffect(txHash: TxHash): Promise<IndexedTxEffect | undefined> {
    const key = txHash.toString();

    const cached = this.txEffectCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const indexedTxEffect = await this.node.getTxEffect(txHash);
      if (indexedTxEffect) {
        this.txEffectCache.set(key, indexedTxEffect);
      }
      return indexedTxEffect ?? undefined;
    } catch (err) {
      this.log?.error(`Failed to fetch TxEffect for ${key}: ${err}`);
      return undefined;
    }
  }

  clearCache(): void {
    this.txEffectCache.clear();
  }

  getCacheSize(): number {
    return this.txEffectCache.size;
  }
}
