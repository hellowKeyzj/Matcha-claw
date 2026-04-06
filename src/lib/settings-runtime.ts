import { hostApiFetch } from '@/lib/host-api';

export async function hostSettingsFetchAll<TSettings extends Record<string, unknown>>() {
  return await hostApiFetch<TSettings>('/api/settings');
}

export async function hostSettingsPutPatch(patch: Record<string, unknown>) {
  await hostApiFetch<{ success: boolean }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function hostSettingsGetValue<TValue = unknown>(key: string) {
  const response = await hostApiFetch<{ value: TValue }>(`/api/settings/${encodeURIComponent(key)}`);
  return response.value;
}

export async function hostSettingsPutValue(key: string, value: unknown) {
  await hostApiFetch<{ success: boolean }>(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export async function hostSettingsReset<TSettings extends Record<string, unknown>>() {
  const response = await hostApiFetch<{ success: boolean; settings: TSettings }>('/api/settings/reset', {
    method: 'POST',
  });
  return response.settings;
}
