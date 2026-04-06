export function normalizePluginId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('@')) {
    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0 && slashIndex < normalized.length - 1) {
      return normalized.slice(slashIndex + 1);
    }
  }
  return normalized;
}

export function resolvePluginId(value: unknown, fallback: string): string {
  return normalizePluginId(value) ?? fallback;
}
