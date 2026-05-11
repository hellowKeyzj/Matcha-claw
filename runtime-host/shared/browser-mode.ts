export type BrowserMode = 'off' | 'relay' | 'native';

export function normalizeBrowserMode(value: unknown): BrowserMode {
  if (value === 'off' || value === 'relay' || value === 'native') {
    return value;
  }
  return 'native';
}
