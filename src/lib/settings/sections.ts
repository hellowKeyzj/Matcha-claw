export const SETTINGS_SECTIONS = [
  'gateway',
  'appearance',
  'aiProviders',
  'taskPlugin',
  'updates',
  'advanced',
  'license',
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = 'gateway';

export function parseSettingsSectionFromSearch(search: string): SettingsSectionKey | null {
  const section = new URLSearchParams(search).get('section');
  if (!section) {
    return null;
  }
  if (!SETTINGS_SECTIONS.includes(section as SettingsSectionKey)) {
    return null;
  }
  return section as SettingsSectionKey;
}

export function buildSettingsSectionLink(section: SettingsSectionKey): string {
  const params = new URLSearchParams({ section });
  return `/settings?${params.toString()}`;
}
