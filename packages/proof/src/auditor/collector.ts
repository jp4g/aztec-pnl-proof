import { BlockNumber } from '@aztec/foundation/branded-types';
import { type Logger, createLogger } from '@aztec/foundation/log';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import type { TxScopedL2Log } from '@aztec/stdlib/logs';

import type { NoteHashMapping, ScanOptions, ScanResult, TaggingSecretEntry } from './types';
import { NoteMapper } from './note-mapper';
import { TagGenerator } from './tag-generator';

const DEFAULT_SCAN_OPTIONS: Required<Omit<ScanOptions, 'fromBlock' | 'toBlock'>> = {
  startIndex: 0,
  maxIndices: 10000,
  batchSize: 100,
};

/**
 * Collects note hashes for a user based on their tagging secrets.
 */
export class NoteHashCollector {
  private noteMapper: NoteMapper;
  private log: Logger;

  constructor(
    private node: AztecNode,
    logger?: Logger,
  ) {
    this.log = logger ?? createLogger('note-collector:auditor');
    this.noteMapper = new NoteMapper(node, this.log);
  }

  async scanForNoteHashes(secrets: TaggingSecretEntry[], options: ScanOptions = {}): Promise<ScanResult> {
    const opts = { ...DEFAULT_SCAN_OPTIONS, ...options };

    this.log.info(
      `Starting scan with ${secrets.length} secrets, indices ${opts.startIndex}-${opts.startIndex + opts.maxIndices}`,
    );

    const inbound: NoteHashMapping[] = [];
    const outbound: NoteHashMapping[] = [];
    const seenTxHashes = new Set<string>();
    let minBlock: BlockNumber | undefined;
    let maxBlock: BlockNumber | undefined;

    for (const secretEntry of secrets) {
      const { secret, direction, counterparty, app, label } = secretEntry;

      this.log.debug(`Scanning ${direction} secret for ${label ?? app.toString().slice(0, 10)}...`);

      for await (const { tags, startIndex, endIndex } of TagGenerator.generateTagBatches(
        secret,
        opts.startIndex,
        opts.startIndex + opts.maxIndices,
        opts.batchSize,
      )) {
        const logsByTag = await this.node.getLogsByTags(tags);

        const allLogs: TxScopedL2Log[] = [];
        for (const logs of logsByTag) {
          allLogs.push(...logs);
        }

        if (allLogs.length === 0) {
          continue;
        }

        const filteredLogs = this.filterLogsByBlockRange(allLogs, opts.fromBlock, opts.toBlock);

        if (filteredLogs.length === 0) {
          continue;
        }

        this.log.debug(`Found ${filteredLogs.length} logs in indices ${startIndex}-${endIndex}`);

        const mappings = await this.noteMapper.mapLogsToNoteHashes(filteredLogs, direction, counterparty, app);

        for (const mapping of mappings) {
          seenTxHashes.add(mapping.txHash.toString());

          if (minBlock === undefined || mapping.blockNumber < minBlock) {
            minBlock = mapping.blockNumber;
          }
          if (maxBlock === undefined || mapping.blockNumber > maxBlock) {
            maxBlock = mapping.blockNumber;
          }

          if (direction === 'inbound') {
            inbound.push(mapping);
          } else {
            outbound.push(mapping);
          }
        }
      }
    }

    const result: ScanResult = {
      inbound,
      outbound,
      totalTransactions: seenTxHashes.size,
      blockRange: {
        from: minBlock ?? BlockNumber(0),
        to: maxBlock ?? BlockNumber(0),
      },
    };

    this.log.info(
      `Scan complete: ${inbound.length} inbound, ${outbound.length} outbound notes ` +
        `across ${seenTxHashes.size} transactions`,
    );

    return result;
  }

  async scanSingleSecret(secretEntry: TaggingSecretEntry, options: ScanOptions = {}): Promise<NoteHashMapping[]> {
    const result = await this.scanForNoteHashes([secretEntry], options);
    return secretEntry.direction === 'inbound' ? result.inbound : result.outbound;
  }

  private filterLogsByBlockRange(
    logs: TxScopedL2Log[],
    fromBlock?: BlockNumber,
    toBlock?: BlockNumber,
  ): TxScopedL2Log[] {
    return logs.filter(log => {
      if (fromBlock !== undefined && log.blockNumber < fromBlock) {
        return false;
      }
      if (toBlock !== undefined && log.blockNumber >= toBlock) {
        return false;
      }
      return true;
    });
  }

  clearCaches(): void {
    this.noteMapper.clearCache();
  }
}
