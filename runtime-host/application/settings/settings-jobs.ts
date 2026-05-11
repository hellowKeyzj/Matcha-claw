import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const SYNC_SETTINGS_RUNTIME_CONFIG_JOB = 'settings.syncRuntimeConfig';

export type SettingsJobSubmission = RuntimeLongTaskSubmission;

export interface SettingsRuntimeConfigSyncPayload {
  readonly settings: Record<string, unknown>;
  readonly syncProxy: boolean;
  readonly syncBrowserMode: boolean;
}

export interface SettingsJobPort {
  submitRuntimeConfigSync(payload: SettingsRuntimeConfigSyncPayload): SettingsJobSubmission;
}

export function createSettingsJobPort(tasks: RuntimeLongTaskSubmissionPort): SettingsJobPort {
  return {
    submitRuntimeConfigSync: (payload) => tasks.submit(SYNC_SETTINGS_RUNTIME_CONFIG_JOB, payload, {
      dedupeKey: SYNC_SETTINGS_RUNTIME_CONFIG_JOB,
    }),
  };
}
