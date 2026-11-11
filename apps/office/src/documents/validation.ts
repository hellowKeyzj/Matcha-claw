import { OfficeError } from '../errors';
import type { DocumentRecord, DocumentResource } from './model';
import { resourcePath } from './store';

export function invalid(message: string): never {
  throw new OfficeError('invalid_request', message);
}

export function object(input: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected an object input.');
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(`Unknown field(s): ${unknown.join(', ')}.`);
  return value;
}

export function text(input: unknown, name: string, maximum = 200): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum) {
    invalid(`${name} must be a non-empty string of at most ${maximum} characters.`);
  }
  return input;
}

export function optionalText(input: unknown, name: string, maximum = 200): string | undefined {
  return input === undefined ? undefined : text(input, name, maximum);
}

export function enumValue<T extends string>(input: unknown, name: string, values: readonly T[]): T {
  if (typeof input !== 'string' || !values.includes(input as T)) invalid(`${name} must be one of: ${values.join(', ')}.`);
  return input as T;
}

export function integer(input: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
    invalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return input;
}

export function optionalBoolean(input: unknown, name: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'boolean') invalid(`${name} must be a boolean.`);
  return input;
}

export function documentId(input: unknown): string {
  if (typeof input !== 'string' || !/^doc_[a-f0-9]{16}$/.test(input)) invalid('documentId must be a Matcha Office document id.');
  return input;
}

export function revision(input: unknown): number {
  return integer(input, 'expectedRevision', 0);
}

export function array(input: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || !input.length || input.length > maximum) {
    invalid(`${name} must be a non-empty array of at most ${maximum} entries.`);
  }
  return input;
}

export function decodeBase64(value: string): Uint8Array {
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    invalid('data must be canonical base64.');
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (!bytes.length || bytes.byteLength > 50 * 1024 * 1024) invalid('data must decode to a file of at most 50 MiB.');
  return bytes;
}

export function resourcesInput(value: unknown, maximum: number, used = 0): readonly DocumentResource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1024) invalid('resources must be an array of at most 1024 entries.');
  const paths = new Set<string>();
  return value.map((entry) => {
    const raw = object(entry, ['path', 'data']);
    const path = resourcePath(text(raw.path, 'resources.path', 1000));
    if (paths.has(path.toLowerCase())) invalid(`Duplicate resource path: ${path}.`);
    paths.add(path.toLowerCase());
    const data = text(raw.data, 'resources.data', maximum);
    used += path.length + data.length;
    if (used > maximum) invalid(`Document and resources exceed the ${maximum} character input budget.`);
    const bytes = decodeBase64(data);
    if (Buffer.from(bytes).toString('base64') !== data) invalid('resources.data must be canonical base64.');
    return { path, bytes };
  });
}

export function resourcesOutput(resources: readonly DocumentResource[]): readonly { path: string; data: string }[] {
  return resources.map(({ path, bytes }) => ({ path, data: Buffer.from(bytes).toString('base64') }));
}

export function editInput(record: DocumentRecord, raw: Readonly<Record<string, unknown>>): { ops?: readonly unknown[]; cells?: readonly unknown[] } {
  if (record.type === 'docx' || record.type === 'pptx') {
    if (raw.cells !== undefined) invalid('cells are only supported for xlsx documents.');
    return { ops: array(raw.ops, 'ops', 1024) };
  }
  if (record.type === 'csv') {
    if (raw.ops !== undefined) throw new OfficeError('unsupported', 'CSV does not support workbook ops; convert to xlsx before editing formulas, formatting or workbook structure.');
    const cells = array(raw.cells, 'cells', 10_000);
    for (const entry of cells) {
      const cell = object(entry, ['cell', 'value', 'sheet']);
      text(cell.cell, 'cells.cell', 50);
      if (cell.sheet !== undefined && cell.sheet !== 'Sheet1') invalid('CSV has only Sheet1.');
      const value = cell.value;
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) invalid('CSV cells require a literal string, finite number, boolean or null value.');
      if (typeof value === 'string' && value.startsWith('=')) throw new OfficeError('unsupported', 'CSV cell edits cannot create formulas; convert to xlsx first.');
    }
    return { cells };
  }
  if (record.type === 'xlsx') {
    if ((raw.ops === undefined) === (raw.cells === undefined)) invalid('xlsx edits require exactly one of ops or cells.');
    return raw.cells === undefined
      ? { ops: array(raw.ops, 'ops', 1024) }
      : { cells: array(raw.cells, 'cells', 10_000) };
  }
  throw new OfficeError('unsupported', `Editing ${record.type} files is not supported.`);
}
