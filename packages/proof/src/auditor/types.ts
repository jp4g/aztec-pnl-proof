import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { ExtendedDirectionalAppTaggingSecret } from '@aztec/stdlib/logs';

/** Direction of note flow relative to the user. */
export type NoteDirection = 'inbound' | 'outbound';

/** A tagging secret with metadata about its direction and counterparty. */
export interface ExportedTaggingSecret {
  secret: ExtendedDirectionalAppTaggingSecret;
  direction: NoteDirection;
  counterparty: AztecAddress;
}

/** JSON-serializable version of ExportedTaggingSecret. */
export interface SerializedExportedTaggingSecret {
  secret: string;
  direction: NoteDirection;
  counterparty: string;
}
