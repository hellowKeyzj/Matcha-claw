import { dirname } from 'node:path';
import type { RuntimeClockPort, RuntimeFileSystemPort, RuntimeIdGeneratorPort } from '../common/runtime-ports';

export interface TeamRuntimeStorageContext {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly idGenerator: RuntimeIdGeneratorPort;
  readonly clock: RuntimeClockPort;
}

export function tmpPath(
  context: TeamRuntimeStorageContext,
  pathname: string,
  nowMs = context.clock.nowMs(),
): string {
  return `${pathname}.${nowMs}.${context.idGenerator.randomId()}.tmp`;
}

export async function atomicWriteJson(
  context: TeamRuntimeStorageContext,
  pathname: string,
  payload: unknown,
): Promise<void> {
  await context.fileSystem.ensureDirectory(dirname(pathname));
  const tmp = tmpPath(context, pathname);
  await context.fileSystem.writeTextFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await context.fileSystem.rename(tmp, pathname);
}

export async function readJsonFile<T>(
  context: TeamRuntimeStorageContext,
  pathname: string,
): Promise<T | null> {
  try {
    return JSON.parse(await context.fileSystem.readTextFile(pathname)) as T;
  } catch {
    return null;
  }
}
