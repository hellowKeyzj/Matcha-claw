import { hostApiFetch, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import { appScope } from '../../runtime-host/shared/runtime-address';

const SETTINGS_RUNTIME_CAPABILITY_ID = 'settings.runtime';

function requiresSettingsJob(payload: unknown): payload is { job: { id: string } } {
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'job' in payload
      && typeof (payload as { job?: { id?: unknown } }).job?.id === 'string'
  );
}

async function settingsRuntimeCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown> = {},
  key?: string,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SETTINGS_RUNTIME_CAPABILITY_ID,
      operationId,
      scope: appScope(),
      target: { kind: 'setting', ...(key ? { key } : {}) },
      input,
    }),
  });
}

export async function hostSettingsFetchAll<TSettings extends Record<string, unknown>>() {
  return await hostApiFetch<TSettings>('/api/settings');
}

export async function hostSettingsPutPatch(patch: Record<string, unknown>) {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>(
    'settings.patch',
    patch,
  );
  if (requiresSettingsJob(response)) {
    await waitForRuntimeJobResult<{ success: boolean }>(response.job.id);
  }
}

export async function hostSettingsGetValue<TValue = unknown>(key: string) {
  const response = await hostApiFetch<{ value: TValue }>(`/api/settings/${encodeURIComponent(key)}`);
  return response.value;
}

export async function hostSettingsPutValue(key: string, value: unknown) {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>(
    'settings.setValue',
    { key, value },
    key,
  );
  if (requiresSettingsJob(response)) {
    await waitForRuntimeJobResult<{ success: boolean }>(response.job.id);
  }
}

export async function hostSettingsReset<TSettings extends Record<string, unknown>>() {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean; settings: TSettings }>('settings.reset');
  return response.settings;
}
