export interface PlatformToolsCallDetail {
  toolCount: number | null;
  available: boolean | null;
  result: 'tools' | 'unavailable' | 'rejected' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'platform-tools': PlatformToolsCallDetail;
  }
}

export function decodePlatformToolsCallDetail(value: unknown): PlatformToolsCallDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid platform-tools call detail');
  }
  const detail = value as Record<string, unknown>;
  if (
    Object.keys(detail).length !== 3
    || !Object.hasOwn(detail, 'toolCount')
    || !Object.hasOwn(detail, 'available')
    || !Object.hasOwn(detail, 'result')
    || !(detail.toolCount === null || (
      typeof detail.toolCount === 'number'
      && Number.isSafeInteger(detail.toolCount)
      && detail.toolCount >= 0
    ))
    || !(detail.available === null || typeof detail.available === 'boolean')
    || !(detail.result === null || detail.result === 'tools'
      || detail.result === 'unavailable' || detail.result === 'rejected')
  ) {
    throw new Error('Invalid platform-tools call detail');
  }
  return {
    toolCount: detail.toolCount as number | null,
    available: detail.available as boolean | null,
    result: detail.result as PlatformToolsCallDetail['result'],
  };
}
