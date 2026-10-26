import type { TFunction } from 'i18next';

export function engineLabel(t: TFunction<'settings'>, name: string): string {
  return t(`networkSearch.engineNames.${name}`, { defaultValue: name });
}
