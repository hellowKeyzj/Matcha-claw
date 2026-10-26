export type SettingsSectionKey = string;

export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = 'gateway';

export function parseSettingsSectionFromSearch(
  search: string,
  contributions?: readonly { id: string }[],
): SettingsSectionKey | null {
  const section = new URLSearchParams(search).get('section');
  if (!section || (contributions && !contributions.some((entry) => entry.id === section))) {
    return null;
  }
  return section;
}

export function buildSettingsSectionLink(section: SettingsSectionKey): string {
  const params = new URLSearchParams({ section });
  return `/settings?${params.toString()}`;
}
