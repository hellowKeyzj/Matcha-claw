import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { app } from 'electron';
import type { WorldRef } from '../../../src/types/world';
import type { WorldEvaluationConfiguration } from '../runtime-host-delivery/control';

const MAX_CONFIGURATION_BYTES = 1024 * 1024;
export class WorldEvaluationConfigurationError extends Error {
  constructor(readonly reason: 'invalid' | 'unavailable', options?: ErrorOptions) {
    super(`world.evaluation.configuration_${reason}`, options);
  }
}

export async function readWorldEvaluationImport(path: string): Promise<unknown> {
  return readConfiguration(path);
}

/** Recovery custody only: this file never establishes canonical World configuration. */
export async function readWorldEvaluationOriginal(world: WorldRef): Promise<unknown> {
  return readConfiguration(originalPath(world), true);
}

/** Preserve the exact request before mutation, without replacing an unresolved request. */
export async function saveWorldEvaluationOriginal(
  configuration: WorldEvaluationConfiguration, admit: () => Promise<void>,
): Promise<'saved' | 'conflict'> {
  const bytes = Buffer.from(JSON.stringify(configuration));
  if (bytes.length === 0 || bytes.length > MAX_CONFIGURATION_BYTES) throw new WorldEvaluationConfigurationError('invalid');
  const path = originalPath(configuration.world);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await admit();
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return isDeepStrictEqual(await readWorldEvaluationOriginal(configuration.world), configuration) ? 'saved' : 'conflict';
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return 'saved';
  } finally { await rm(temporary, { force: true }); }
}

export async function clearWorldEvaluationOriginal(configuration: WorldEvaluationConfiguration): Promise<void> {
  if (isDeepStrictEqual(await readWorldEvaluationOriginal(configuration.world), configuration)) {
    await rm(originalPath(configuration.world));
  }
}

function originalPath(world: WorldRef): string {
  const key = createHash('sha256').update(JSON.stringify([world.tenantId, world.worldId])).digest('hex');
  return join(app.getPath('userData'), 'world-evaluation-requests', `${key}.json`);
}

async function readConfiguration(path: string, optional = false): Promise<unknown> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorldEvaluationConfigurationError('unavailable', { cause: error });
  }
  try {
    if (!(await file.stat()).isFile()) throw new WorldEvaluationConfigurationError('invalid');
    const bytes = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    try {
      if (size === 0 || size > MAX_CONFIGURATION_BYTES) throw new Error();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size))) as unknown;
    } catch (error) { throw new WorldEvaluationConfigurationError('invalid', { cause: error }); }
  } catch (error) {
    if (error instanceof WorldEvaluationConfigurationError) throw error;
    throw new WorldEvaluationConfigurationError('unavailable', { cause: error });
  } finally { await file.close(); }
}
