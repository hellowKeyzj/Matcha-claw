import { join } from 'node:path';
import type { RuntimeClockPort, RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { RuntimeHostPrelaunchMaintenanceTaskName } from '../../runtime-host/prelaunch-maintenance-cache';

const CACHE_SCHEMA_VERSION = 1;

export type PrelaunchMaintenanceCacheKeyInput = string | (() => string | Promise<string>);
export type PrelaunchMaintenanceTask = () => Promise<void | boolean>;

export interface RuntimeHostPrelaunchMaintenanceRunResult {
  executed: boolean;
  reason: 'cache-hit' | 'cache-miss' | 'cache-unavailable' | 'task-failed';
}

interface CacheEntry {
  key: string;
  updatedAt: string;
}

interface CacheFile {
  schemaVersion: number;
  tasks: Partial<Record<RuntimeHostPrelaunchMaintenanceTaskName, CacheEntry>>;
}

export interface PrelaunchMaintenanceCacheWorkflowDeps {
  fileSystem: RuntimeFileSystemPort;
  clock: RuntimeClockPort;
}

export class PrelaunchMaintenanceCacheWorkflow {
  constructor(private readonly deps: PrelaunchMaintenanceCacheWorkflowDeps) {}

  async directoryChildrenSignature(pathname: string, maxEntries = 200): Promise<string> {
    return await directoryChildrenSignature(this.deps.fileSystem, pathname, maxEntries);
  }

  async runTask(input: {
    taskName: RuntimeHostPrelaunchMaintenanceTaskName;
    cacheKey: PrelaunchMaintenanceCacheKeyInput;
    task: PrelaunchMaintenanceTask;
    cachePath: string;
  }): Promise<RuntimeHostPrelaunchMaintenanceRunResult> {
    const readCacheKey = async (): Promise<string> => (
      typeof input.cacheKey === 'function' ? await input.cacheKey() : input.cacheKey
    );
    const cache = await readCache(this.deps.fileSystem, input.cachePath);
    if (!cache) {
      await input.task();
      return { executed: true, reason: 'cache-unavailable' };
    }

    let initialCacheKey: string;
    try {
      initialCacheKey = await readCacheKey();
    } catch {
      await input.task();
      return { executed: true, reason: 'cache-unavailable' };
    }

    if (cache.tasks[input.taskName]?.key === initialCacheKey) {
      return { executed: false, reason: 'cache-hit' };
    }

    const taskResult = await input.task();
    if (taskResult === false) {
      return { executed: true, reason: 'task-failed' };
    }

    let finalCacheKey: string;
    try {
      finalCacheKey = await readCacheKey();
    } catch {
      return { executed: true, reason: 'cache-unavailable' };
    }

    cache.tasks[input.taskName] = {
      key: finalCacheKey,
      updatedAt: this.deps.clock.nowIso(),
    };
    await writeCache(this.deps.fileSystem, input.cachePath, cache);
    return { executed: true, reason: 'cache-miss' };
  }
}

function emptyCache(): CacheFile {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    tasks: {},
  };
}

async function readCache(
  fileSystem: RuntimeFileSystemPort,
  cachePath: string,
): Promise<CacheFile | null> {
  try {
    if (!(await fileSystem.exists(cachePath))) {
      return emptyCache();
    }
    const parsed = JSON.parse(await fileSystem.readTextFile(cachePath)) as CacheFile;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !parsed.tasks) {
      return emptyCache();
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(
  fileSystem: RuntimeFileSystemPort,
  cachePath: string,
  cache: CacheFile,
): Promise<boolean> {
  try {
    await fileSystem.ensureDirectory(join(cachePath, '..'));
    await fileSystem.writeTextFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`);
  return `{${entries.join(',')}}`;
}

export async function pathSignature(
  fileSystem: RuntimeFileSystemPort,
  pathname: string,
): Promise<string> {
  try {
    const info = await fileSystem.stat(pathname);
    return `${info.isFile ? 'file' : 'dir'}:${Math.round(info.mtimeMs)}:${info.size}`;
  } catch {
    return 'missing';
  }
}

export async function directoryChildrenSignature(
  fileSystem: RuntimeFileSystemPort,
  pathname: string,
  maxEntries = 200,
): Promise<string> {
  try {
    const entries = await Promise.all((await fileSystem.listDirectory(pathname))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, maxEntries)
      .map(async (entry) => {
        const childPath = join(pathname, entry.name);
        return [
          entry.name,
          entry.isDirectory ? 'dir' : 'file',
          await pathSignature(fileSystem, childPath),
        ].join(':');
      }));
    return stableJson(entries);
  } catch {
    return 'missing';
  }
}

export function buildPrelaunchMaintenanceCacheKey(parts: Record<string, unknown>): string {
  return stableJson({
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...parts,
  });
}
