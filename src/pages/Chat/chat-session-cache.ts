export const MAX_CACHED_CHAT_SESSIONS = 20;

export function getSessionCacheValue<T>(
  map: Map<string, T>,
  sessionKey: string,
): T | undefined {
  const cached = map.get(sessionKey);
  if (cached === undefined) {
    return undefined;
  }
  map.delete(sessionKey);
  map.set(sessionKey, cached);
  return cached;
}

export function rememberSessionCacheValue<T>(
  map: Map<string, T>,
  sessionKey: string,
  value: T,
  maxSize = MAX_CACHED_CHAT_SESSIONS,
): void {
  if (map.has(sessionKey)) {
    map.delete(sessionKey);
  }
  map.set(sessionKey, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    map.delete(oldestKey);
  }
}
