import { hostApiFetch, hostCapabilityExecute, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const SETTINGS_RUNTIME_CAPABILITY_ID = 'settings.runtime';

function requiresSettingsJob(payload: unknown): payload is { job: { id: string } } {
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'job' in payload
      && typeof (payload as { job?: { id?: unknown } }).job?.id === 'string'
  );
}

async function settingsRuntimeCapabilityExecute<TResult>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown> = {}): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: SETTINGS_RUNTIME_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

export async function hostSettingsFetchAll<TSettings extends Record<string, unknown>>() {
  return await hostApiFetch<TSettings>('/api/settings');
}

export async function hostSettingsPutPatch(patch: Record<string, unknown>, runtimeAddress: RuntimeAddress) {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>(
    'settings.patch',
    runtimeAddress,
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

export async function hostSettingsPutValue(key: string, value: unknown, runtimeAddress: RuntimeAddress) {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>(
    'settings.setValue',
    runtimeAddress,
    { key, value },
  );
  if (requiresSettingsJob(response)) {
    await waitForRuntimeJobResult<{ success: boolean }>(response.job.id);
  }
}

export async function hostSettingsReset<TSettings extends Record<string, unknown>>(runtimeAddress: RuntimeAddress) {
  const response = await settingsRuntimeCapabilityExecute<{ success: boolean; settings: TSettings }>('settings.reset', runtimeAddress);
  return response.settings;
}
