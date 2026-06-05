export const ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS = 32768;
export const MINIMAX_M27_MAX_TOKENS = 131072;

export function isAnthropicMessagesApi(api: unknown): boolean {
  return api === 'anthropic-messages';
}

export function normalizePositiveMaxTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

export function resolveAnthropicMessagesDefaultMaxTokens(
  providerKey?: string,
  entry?: Record<string, unknown>,
  model?: Record<string, unknown>,
): number {
  const normalizedProvider = (providerKey || '').toLowerCase();
  if (normalizedProvider === 'minimax' || normalizedProvider.startsWith('minimax-portal')) {
    return MINIMAX_M27_MAX_TOKENS;
  }

  const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl.toLowerCase() : '';
  if (baseUrl.includes('api.minimax.io') || baseUrl.includes('api.minimaxi.com')) {
    return MINIMAX_M27_MAX_TOKENS;
  }

  const modelId = typeof model?.id === 'string'
    ? model.id.toLowerCase()
    : (typeof model?.modelId === 'string' ? model.modelId.toLowerCase() : '');
  if (modelId === 'minimax-m2.7' || modelId === 'minimax-m2.7-highspeed') {
    return MINIMAX_M27_MAX_TOKENS;
  }

  return ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS;
}

export function withAnthropicMessagesModelMaxTokens<T extends Record<string, unknown>>(
  model: T,
  providerKey?: string,
  entry?: Record<string, unknown>,
): T {
  const resolved = normalizePositiveMaxTokens(model.maxTokens);
  if (resolved !== undefined) {
    return model.maxTokens === resolved ? model : { ...model, maxTokens: resolved };
  }
  return {
    ...model,
    maxTokens: resolveAnthropicMessagesDefaultMaxTokens(providerKey, entry, model),
  };
}
