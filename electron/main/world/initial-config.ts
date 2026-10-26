import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { app } from 'electron';
import { MAX_RUNTIME_HOST_BOOTSTRAP_BYTES } from '../runtime-host-delivery/bootstrap';

export class InitialWorldConfigurationError extends Error {
  constructor(readonly reason: 'invalid' | 'unavailable', options?: ErrorOptions) {
    super(`world.initial_config_${reason}`, options);
  }
}

/** Only the private Host Wire decodes authority configuration; Main never grants it. */
export async function readInitialWorldBootstrap(): Promise<Readonly<Record<string, unknown>> | undefined> {
  let file;
  try { file = await open(join(app.getPath('userData'), 'world-initial.v1.json'), 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InitialWorldConfigurationError('unavailable', { cause: error });
  }
  try { return await readConfiguration(file); }
  finally { await file.close(); }
}

/** Publish one complete, synced original request without replacing an earlier commit. */
export async function saveInitialWorldBootstrap(
  configuration: Readonly<Record<string, unknown>>, admit: () => Promise<void>,
): Promise<'saved' | 'conflict'> {
  const bytes = Buffer.from(JSON.stringify(configuration));
  if (bytes.length === 0 || bytes.length > MAX_RUNTIME_HOST_BOOTSTRAP_BYTES) throw new Error('world.initial_config_invalid');
  const path = join(app.getPath('userData'), 'world-initial.v1.json');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await admit();
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return isDeepStrictEqual(await readInitialWorldBootstrap(), configuration) ? 'saved' : 'conflict';
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return 'saved';
  } finally { await rm(temporary, { force: true }); }
}

/** Drop custody only after the exact original receipt and accessible World were observed. */
export async function clearInitialWorldBootstrap(configuration: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (!isDeepStrictEqual(await readInitialWorldBootstrap(), configuration)) return false;
  const path = join(app.getPath('userData'), 'world-initial.v1.json');
  await rm(path);
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return true;
}

async function readConfiguration(file: Awaited<ReturnType<typeof open>>): Promise<Readonly<Record<string, unknown>>> {
  const bytes = Buffer.alloc(MAX_RUNTIME_HOST_BOOTSTRAP_BYTES + 1);
  let size = 0;
  try {
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
  } catch (error) { throw new InitialWorldConfigurationError('unavailable', { cause: error }); }
  try {
    if (size === 0 || size > MAX_RUNTIME_HOST_BOOTSTRAP_BYTES) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Readonly<Record<string, unknown>>;
  } catch (error) { throw new InitialWorldConfigurationError('invalid', { cause: error }); }
}
