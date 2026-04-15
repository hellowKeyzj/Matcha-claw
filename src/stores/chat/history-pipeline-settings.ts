import { useSettingsStore } from '../settings';

interface ReadHistoryLoadPipelineStrategyKeyFromSettingsInput {
  getSettings?: () => {
    chatHistoryPipelineStrategyKey?: unknown;
  };
}

export function readHistoryLoadPipelineStrategyKeyFromSettings(
  input: ReadHistoryLoadPipelineStrategyKeyFromSettingsInput = {},
): string | null {
  const {
    getSettings = () => useSettingsStore.getState(),
  } = input;

  const settings = getSettings();
  const raw = settings?.chatHistoryPipelineStrategyKey;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}
