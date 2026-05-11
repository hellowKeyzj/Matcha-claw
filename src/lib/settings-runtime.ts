import { hostApiFetch, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';

function requiresSettingsJob(payload: unknown): payload is { job: { id: string } } {
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'job' in payload
      && typeof (payload as { job?: { id?: unknown } }).job?.id === 'string'
  );
}

export async function hostSettingsFetchAll<TSettings extends Record<string, unknown>>() {
  return await hostApiFetch<TSettings>('/api/settings');
}

export async function hostSettingsPutPatch(patch: Record<string, unknown>) {
  const response = await hostApiFetch<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  if (requiresSettingsJob(response)) {
    await waitForRuntimeJobResult<{ success: boolean }>(response.job.id);
  }
}

export async function hostSettingsGetValue<TValue = unknown>(key: string) {
  const response = await hostApiFetch<{ value: TValue }>(`/api/settings/${encodeURIComponent(key)}`);
  return response.value;
}

export async function hostSettingsPutValue(key: string, value: unknown) {
  const response = await hostApiFetch<{ success: boolean } | RuntimeJobSubmission<{ success: boolean }>>(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  if (requiresSettingsJob(response)) {
    await waitForRuntimeJobResult<{ success: boolean }>(response.job.id);
  }
}

export async function hostSettingsReset<TSettings extends Record<string, unknown>>() {
  const response = await hostApiFetch<{ success: boolean; settings: TSettings }>('/api/settings/reset', {
    method: 'POST',
  });
  return response.settings;
}
