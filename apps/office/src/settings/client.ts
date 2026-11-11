import { appApi } from '../documents/client';

export type OfficeSettings = {
  documentTheme: 'light' | 'dark' | 'follow';
  autoSaveDefault: { on: boolean; updatedAt: number };
  authorName: string;
  authorNameSetting: { value: string; fallback: string };
};

export type OfficeSettingsPatch = {
  documentTheme?: OfficeSettings['documentTheme'];
  autoSaveDefault?: boolean;
  authorName?: string;
};

async function call(channel: string, args: unknown[]): Promise<OfficeSettings> {
  const app = document.documentElement.dataset.officeApp;
  if (!app || !['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].includes(app)) throw new Error('Office editor identity is missing.');
  const response = await appApi().call(`office_${app}_ipc`, { channel, arguments: args });
  const output = response.structuredContent as { result?: OfficeSettings; error?: string } | undefined;
  if (response.isError) throw new Error(output?.error ?? 'Office settings operation failed.');
  return output?.result as OfficeSettings;
}

export function officeSettings(): Promise<OfficeSettings> {
  return call('office:settings:get', []);
}

export function setOfficeSettings(patch: OfficeSettingsPatch): Promise<OfficeSettings> {
  return call('office:settings:set', [patch]);
}

export function onOfficeSettingsChanged(handler: (settings: OfficeSettings) => void): () => void {
  return appApi().subscribe(({ topic, data }) => {
    if (topic === 'office.settings.changed') handler(data as OfficeSettings);
  });
}
