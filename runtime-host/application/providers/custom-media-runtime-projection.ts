export const MATCHACLAW_MEDIA_PLUGIN_ID = 'matchaclaw-media';
export const MATCHACLAW_MEDIA_PROVIDER_ID = MATCHACLAW_MEDIA_PLUGIN_ID;

export function toMatchaClawMediaModelRef(providerKey: string, modelId: string): string {
  return `${MATCHACLAW_MEDIA_PROVIDER_ID}/${providerKey}/${modelId}`;
}

export function toMatchaClawMediaRouteModelId(providerKey: string, modelId: string): string {
  return `${providerKey}/${modelId}`;
}

export function parseMatchaClawMediaRouteModelId(modelId: string): { providerKey: string; modelId: string } | null {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return null;
  const providerKey = modelId.slice(0, slash).trim();
  const innerModelId = modelId.slice(slash + 1).trim();
  if (!providerKey || !innerModelId) return null;
  return { providerKey, modelId: innerModelId };
}

export function isCustomMediaCredential(account: Record<string, unknown>): boolean {
  return account.vendorId === 'custom' && account.providerKind === 'media';
}
