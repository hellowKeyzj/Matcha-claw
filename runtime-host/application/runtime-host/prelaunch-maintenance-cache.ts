import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getRuntimeHostDataDir } from '../../api/storage/paths';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'matchaclaw-gateway-prelaunch-maintenance-cache.json';

export type RuntimeHostPrelaunchMaintenanceTaskName =
  | 'configured-channel-plugin-maintenance'
  | 'configured-managed-plugin-maintenance';

export interface RuntimeHostPrelaunchMaintenanceRunResult {
  executed: boolean;
  reason: 'cache-hit' | 'cache-miss' | 'cache-unavailable' | 'task-failed';
}

type CacheKeyInput = string | (() => string | Promise<string>);
type MaintenanceTask = () => Promise<void | boolean>;

interface CacheEntry {
  key: string;
  updatedAt: string;
}

interface CacheFile {
  schemaVersion: number;
  tasks: Partial<Record<RuntimeHostPrelaunchMaintenanceTaskName, CacheEntry>>;
}

function getDefaultCachePath(): string {
  return join(getRuntimeHostDataDir(), CACHE_FILE_NAME);
}

function emptyCache(): CacheFile {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    tasks: {},
  };
}

function readCache(cachePath: string): CacheFile | null {
  try {
    if (!existsSync(cachePath)) {
      return emptyCache();
    }
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !parsed.tasks) {
      return emptyCache();
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: CacheFile): boolean {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
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

export function pathSignature(pathname: string): string {
  try {
    const info = statSync(pathname);
    return `${info.isDirectory() ? 'dir' : 'file'}:${Math.round(info.mtimeMs)}:${info.size}`;
  } catch {
    return 'missing';
  }
}

export function directoryChildrenSignature(pathname: string, maxEntries = 200): string {
  try {
    const entries = readdirSync(pathname, { withFileTypes: true, encoding: 'utf8' })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, maxEntries)
      .map((entry) => {
        const childPath = join(pathname, entry.name);
        return [
          entry.name,
          entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
          pathSignature(childPath),
        ].join(':');
      });
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

export async function runCachedPrelaunchMaintenanceTask(
  taskName: RuntimeHostPrelaunchMaintenanceTaskName,
  cacheKey: CacheKeyInput,
  task: MaintenanceTask,
  options: { cachePath?: string } = {},
): Promise<RuntimeHostPrelaunchMaintenanceRunResult> {
  const readCacheKey = async (): Promise<string> => (typeof cacheKey === 'function' ? await cacheKey() : cacheKey);
  const cachePath = options.cachePath ?? getDefaultCachePath();
  const cache = readCache(cachePath);
  if (!cache) {
    await task();
    return { executed: true, reason: 'cache-unavailable' };
  }

  let initialCacheKey: string;
  try {
    initialCacheKey = await readCacheKey();
  } catch {
    await task();
    return { executed: true, reason: 'cache-unavailable' };
  }

  if (cache.tasks[taskName]?.key === initialCacheKey) {
    return { executed: false, reason: 'cache-hit' };
  }

  const taskResult = await task();
  if (taskResult === false) {
    return { executed: true, reason: 'task-failed' };
  }

  let finalCacheKey: string;
  try {
    finalCacheKey = await readCacheKey();
  } catch {
    return { executed: true, reason: 'cache-unavailable' };
  }

  cache.tasks[taskName] = {
    key: finalCacheKey,
    updatedAt: new Date().toISOString(),
  };
  writeCache(cachePath, cache);
  return { executed: true, reason: 'cache-miss' };
}
