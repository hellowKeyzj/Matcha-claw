export interface SettingsCallDetail {
  operation: 'readCurrent' | 'replaceDesired';
  settlement: {
    revision: number;
    outcome: 'confirmed' | 'rejected' | 'outcome_unknown';
  } | null;
  launchAtStartup: boolean | null;
  failure: 'invalidRequest' | 'unauthorized' | 'ownerUnavailable' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    settings: SettingsCallDetail;
  }
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function decodeSettingsCallDetail(value: unknown): SettingsCallDetail | undefined {
  if (!hasKeys(value, ['operation', 'settlement', 'launchAtStartup', 'failure'])
    || !['readCurrent', 'replaceDesired'].includes(value.operation as string)
    || ![null, 'invalidRequest', 'unauthorized', 'ownerUnavailable'].includes(value.failure as string | null)) {
    return undefined;
  }
  if (value.settlement !== null
    && (!hasKeys(value.settlement, ['revision', 'outcome'])
      || !Number.isSafeInteger(value.settlement.revision) || (value.settlement.revision as number) < 0
      || !['confirmed', 'rejected', 'outcome_unknown'].includes(value.settlement.outcome as string))) {
    return undefined;
  }
  if (value.settlement === null ? value.launchAtStartup !== null
    : (value.operation !== 'replaceDesired' || value.failure !== null || typeof value.launchAtStartup !== 'boolean')) {
    return undefined;
  }
  return value as unknown as SettingsCallDetail;
}
