import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { ExtendedDirectionalAppTaggingSecret } from '@aztec/stdlib/logs';

import type {
  SerializedTaggingSecretEntry,
  SerializedTaggingSecretExport,
  TaggingSecretEntry,
  TaggingSecretExport,
} from './types';

export function serializeTaggingSecretExport(exportData: TaggingSecretExport): SerializedTaggingSecretExport {
  return {
    account: exportData.account.toString(),
    secrets: exportData.secrets.map(serializeTaggingSecretEntry),
    exportedAt: exportData.exportedAt,
  };
}

export function deserializeTaggingSecretExport(json: SerializedTaggingSecretExport): TaggingSecretExport {
  return {
    account: AztecAddress.fromString(json.account),
    secrets: json.secrets.map(deserializeTaggingSecretEntry),
    exportedAt: json.exportedAt,
  };
}

function serializeTaggingSecretEntry(entry: TaggingSecretEntry): SerializedTaggingSecretEntry {
  return {
    secret: entry.secret.toString(),
    direction: entry.direction,
    counterparty: entry.counterparty.toString(),
    app: entry.app.toString(),
    label: entry.label,
  };
}

function deserializeTaggingSecretEntry(entry: SerializedTaggingSecretEntry): TaggingSecretEntry {
  return {
    secret: ExtendedDirectionalAppTaggingSecret.fromString(entry.secret),
    direction: entry.direction,
    counterparty: AztecAddress.fromString(entry.counterparty),
    app: AztecAddress.fromString(entry.app),
    label: entry.label,
  };
}

export function validateSerializedExport(obj: unknown): obj is SerializedTaggingSecretExport {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Export must be an object');
  }

  const export_ = obj as Record<string, unknown>;

  if (typeof export_.account !== 'string') {
    throw new Error('Export must have an account field (string)');
  }

  if (!Array.isArray(export_.secrets)) {
    throw new Error('Export must have a secrets field (array)');
  }

  if (typeof export_.exportedAt !== 'number') {
    throw new Error('Export must have an exportedAt field (number)');
  }

  for (let i = 0; i < export_.secrets.length; i++) {
    const secret = export_.secrets[i] as Record<string, unknown>;
    if (typeof secret.secret !== 'string') {
      throw new Error(`Secret ${i} must have a secret field (string)`);
    }
    if (secret.direction !== 'inbound' && secret.direction !== 'outbound') {
      throw new Error(`Secret ${i} must have a direction field ('inbound' or 'outbound')`);
    }
    if (typeof secret.counterparty !== 'string') {
      throw new Error(`Secret ${i} must have a counterparty field (string)`);
    }
    if (typeof secret.app !== 'string') {
      throw new Error(`Secret ${i} must have an app field (string)`);
    }
  }

  return true;
}

export function parseTaggingSecretExport(jsonString: string): TaggingSecretExport {
  const parsed = JSON.parse(jsonString);
  validateSerializedExport(parsed);
  return deserializeTaggingSecretExport(parsed);
}
