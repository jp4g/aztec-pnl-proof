import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { ExtendedDirectionalAppTaggingSecret } from '@aztec/stdlib/logs';

import type {
  SerializedExportedTaggingSecret,
  ExportedTaggingSecret,
} from './types';

export function serializeExportedTaggingSecrets(secrets: ExportedTaggingSecret[]): SerializedExportedTaggingSecret[] {
  return secrets.map(serializeExportedTaggingSecret);
}

export function deserializeExportedTaggingSecrets(json: SerializedExportedTaggingSecret[]): ExportedTaggingSecret[] {
  return json.map(deserializeExportedTaggingSecret);
}

function serializeExportedTaggingSecret(entry: ExportedTaggingSecret): SerializedExportedTaggingSecret {
  return {
    secret: entry.secret.toString(),
    direction: entry.direction,
    counterparty: entry.counterparty.toString(),
  };
}

function deserializeExportedTaggingSecret(entry: SerializedExportedTaggingSecret): ExportedTaggingSecret {
  return {
    secret: ExtendedDirectionalAppTaggingSecret.fromString(entry.secret),
    direction: entry.direction,
    counterparty: AztecAddress.fromString(entry.counterparty),
  };
}

export function validateSerializedExport(obj: unknown): obj is SerializedExportedTaggingSecret[] {
  if (!Array.isArray(obj)) {
    throw new Error('Export must be an array');
  }

  for (let i = 0; i < obj.length; i++) {
    const secret = obj[i] as Record<string, unknown>;
    if (typeof secret.secret !== 'string') {
      throw new Error(`Secret ${i} must have a secret field (string)`);
    }
    if (secret.direction !== 'inbound' && secret.direction !== 'outbound') {
      throw new Error(`Secret ${i} must have a direction field ('inbound' or 'outbound')`);
    }
    if (typeof secret.counterparty !== 'string') {
      throw new Error(`Secret ${i} must have a counterparty field (string)`);
    }
  }

  return true;
}

export function parseExportedTaggingSecrets(jsonString: string): ExportedTaggingSecret[] {
  const parsed = JSON.parse(jsonString);
  validateSerializedExport(parsed);
  return deserializeExportedTaggingSecrets(parsed);
}
