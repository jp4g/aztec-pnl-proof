import type { BlockNumber } from '@aztec/foundation/branded-types';
import type { Fr } from '@aztec/foundation/curves/bn254';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { DirectionalAppTaggingSecret } from '@aztec/stdlib/logs';
import type { TxHash } from '@aztec/stdlib/tx';

/** Direction of note flow relative to the user. */
export type NoteDirection = 'inbound' | 'outbound';

/** A tagging secret with metadata about its direction and counterparty. */
export interface TaggingSecretEntry {
  secret: DirectionalAppTaggingSecret;
  direction: NoteDirection;
  counterparty: AztecAddress;
  app: AztecAddress;
  label?: string;
}

/** Complete export of tagging secrets for an account. */
export interface TaggingSecretExport {
  account: AztecAddress;
  secrets: TaggingSecretEntry[];
  exportedAt: number;
}

/** JSON-serializable version of TaggingSecretEntry. */
export interface SerializedTaggingSecretEntry {
  secret: string;
  direction: NoteDirection;
  counterparty: string;
  app: string;
  label?: string;
}

/** JSON-serializable version of TaggingSecretExport. */
export interface SerializedTaggingSecretExport {
  account: string;
  secrets: SerializedTaggingSecretEntry[];
  exportedAt: number;
}

/** Options for scanning the chain for notes. */
export interface ScanOptions {
  startIndex?: number;
  maxIndices?: number;
  batchSize?: number;
  fromBlock?: BlockNumber;
  toBlock?: BlockNumber;
}

/** Mapping between a discovered log and its corresponding note hash. */
export interface NoteHashMapping {
  txHash: TxHash;
  blockNumber: BlockNumber;
  logIndexInTx: number;
  noteHash: Fr;
  dataStartIndexForTx: number;
  direction: NoteDirection;
  counterparty: AztecAddress;
  app: AztecAddress;
  encryptedLog: Buffer;
}

/** Result of scanning the chain for notes. */
export interface ScanResult {
  inbound: NoteHashMapping[];
  outbound: NoteHashMapping[];
  totalTransactions: number;
  blockRange: {
    from: BlockNumber;
    to: BlockNumber;
  };
}
