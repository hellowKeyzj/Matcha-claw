const AUTH_PROFILE_PROVIDER_KEY_MAP: Record<string, string> = {
  'openai-codex': 'openai',
  'google-gemini-cli': 'google',
};

const AUTH_PROFILE_PROVIDER_KEY_REVERSE_MAP: Record<string, string[]> = Object.entries(
  AUTH_PROFILE_PROVIDER_KEY_MAP,
).reduce<Record<string, string[]>>((accumulator, [rawKey, normalizedKey]) => {
  if (!accumulator[normalizedKey]) {
    accumulator[normalizedKey] = [];
  }
  accumulator[normalizedKey].push(rawKey);
  return accumulator;
}, {});

export function normalizeAuthProfileProviderKey(provider: string): string {
  return AUTH_PROFILE_PROVIDER_KEY_MAP[provider] ?? provider;
}

export function expandProviderKeysForDeletion(provider: string): string[] {
  return [provider, ...(AUTH_PROFILE_PROVIDER_KEY_REVERSE_MAP[provider] ?? [])];
}

export function addProvidersFromProfileEntries(
  profiles: Record<string, unknown> | undefined,
  target: Set<string>,
): void {
  if (!profiles || typeof profiles !== 'object') {
    return;
  }

  for (const profile of Object.values(profiles)) {
    const provider = typeof (profile as Record<string, unknown>)?.provider === 'string'
      ? ((profile as Record<string, unknown>).provider as string)
      : undefined;
    if (!provider) {
      continue;
    }
    target.add(normalizeAuthProfileProviderKey(provider));
  }
}
