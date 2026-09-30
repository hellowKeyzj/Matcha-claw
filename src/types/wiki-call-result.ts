export interface WikiWriteResult {
  relativePath: string;
  revision: { id: string; size: number; modifiedAtMs: number };
}

export interface WikiDeleteSourceResult {
  sourceRelativePath: string;
  deletedPages: string[];
  updatedPages: string[];
  deletedMedia: string[];
}

export type WikiCallResult =
  | { callId: string; operation: 'apply-generated-pages'; result: { writtenPages: WikiWriteResult[] } }
  | { callId: string; operation: 'delete-source'; result: WikiDeleteSourceResult };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !/^[a-z]:/i.test(value) && !value.startsWith('/') && !value.includes('\0')
    && value.split('/').every((part) => part !== '..');
}

function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(relativePath);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function writeResult(value: unknown): value is WikiWriteResult {
  if (!record(value) || !exact(value, ['relativePath', 'revision']) || !relativePath(value.relativePath)
    || !record(value.revision) || !exact(value.revision, ['id', 'size', 'modifiedAtMs'])) return false;
  return typeof value.revision.id === 'string' && /^[a-f0-9]{16}$/.test(value.revision.id)
    && integer(value.revision.size) && integer(value.revision.modifiedAtMs);
}

export function decodeWikiCallResult(value: unknown): WikiCallResult {
  if (record(value) && exact(value, ['callId', 'operation', 'result']) && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId)
    && record(value.result)) {
    if (value.operation === 'apply-generated-pages' && exact(value.result, ['writtenPages'])
      && Array.isArray(value.result.writtenPages) && value.result.writtenPages.every(writeResult)) {
      return { callId: value.callId, operation: value.operation, result: { writtenPages: value.result.writtenPages } };
    }
    if (value.operation === 'delete-source'
      && exact(value.result, ['sourceRelativePath', 'deletedPages', 'updatedPages', 'deletedMedia'])
      && relativePath(value.result.sourceRelativePath) && paths(value.result.deletedPages)
      && paths(value.result.updatedPages) && paths(value.result.deletedMedia)) {
      return { callId: value.callId, operation: value.operation, result: {
        sourceRelativePath: value.result.sourceRelativePath,
        deletedPages: value.result.deletedPages, updatedPages: value.result.updatedPages, deletedMedia: value.result.deletedMedia,
      } };
    }
  }
  throw new Error('Invalid Wiki call result');
}
