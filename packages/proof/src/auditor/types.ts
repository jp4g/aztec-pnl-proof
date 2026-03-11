import type { Fr } from '@aztec/foundation/curves/bn254';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { DirectionalAppTaggingSecret } from '@aztec/stdlib/logs';

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
