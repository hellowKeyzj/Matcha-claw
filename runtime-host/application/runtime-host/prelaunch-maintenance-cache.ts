import { join } from 'node:path';
import type {
  PrelaunchMaintenanceCacheKeyInput,
  PrelaunchMaintenanceCacheWorkflow,
  PrelaunchMaintenanceTask,
  RuntimeHostPrelaunchMaintenanceRunResult,
} from '../workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow';
export {
  buildPrelaunchMaintenanceCacheKey,
  directoryChildrenSignature,
  pathSignature,
  stableJson,
  type RuntimeHostPrelaunchMaintenanceRunResult,
} from '../workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow';

const CACHE_FILE_NAME = 'matchaclaw-gateway-prelaunch-maintenance-cache.json';

export type RuntimeHostPrelaunchMaintenanceTaskName =
  | 'stale-builtin-extension-cleanup'
  | 'configured-channel-plugin-maintenance'
  | 'configured-managed-plugin-maintenance';

export interface PrelaunchMaintenanceCacheStoragePort {
  getRuntimeHostDataDir(): string;
}

export class PrelaunchMaintenanceCacheRepository {
  constructor(
    private readonly storage: PrelaunchMaintenanceCacheStoragePort,
    private readonly cacheWorkflow: Pick<PrelaunchMaintenanceCacheWorkflow, 'directoryChildrenSignature' | 'runTask'>,
  ) {}

  async directoryChildrenSignature(pathname: string, maxEntries = 200): Promise<string> {
    return await this.cacheWorkflow.directoryChildrenSignature(pathname, maxEntries);
  }

  async runTask(
    taskName: RuntimeHostPrelaunchMaintenanceTaskName,
    cacheKey: PrelaunchMaintenanceCacheKeyInput,
    task: PrelaunchMaintenanceTask,
  ): Promise<RuntimeHostPrelaunchMaintenanceRunResult> {
    return await this.cacheWorkflow.runTask({
      taskName,
      cacheKey,
      task,
      cachePath: join(this.storage.getRuntimeHostDataDir(), CACHE_FILE_NAME),
    });
  }
}
