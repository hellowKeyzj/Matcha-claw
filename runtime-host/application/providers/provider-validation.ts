import { getProviderConfig } from './provider-registry';
import type { ProviderProtocol } from './provider-types';

type ValidationProfile =
  | 'openai-completions'
  | 'openai-responses'
  | 'google-query-key'
  | 'anthropic-header'
  | 'openrouter'
  | 'none';

type ValidationResult = { valid: boolean; error?: string; status?: number };
type ClassifiedValidationResult = ValidationResult & { authFailure?: boolean };

const AUTH_ERROR_PATTERN = /\b(unauthorized|forbidden|access denied|invalid api key|api key invalid|incorrect api key|api key incorrect|authentication failed|auth failed|invalid credential|credential invalid|invalid signature|signature invalid|invalid access token|access token invalid|invalid bearer token|bearer token invalid|access token expired)\b|鉴权失败|認証失敗|认证失败|無效密鑰|无效密钥|密钥无效|密鑰無效|憑證無效|凭证无效/i;
const AUTH_ERROR_CODE_PATTERN = /\b(unauthorized|forbidden|access[_-]?denied|invalid[_-]?api[_-]?key|api[_-]?key[_-]?invalid|incorrect[_-]?api[_-]?key|api[_-]?key[_-]?incorrect|authentication[_-]?failed|auth[_-]?failed|invalid[_-]?credential|credential[_-]?invalid|invalid[_-]?signature|signature[_-]?invalid|invalid[_-]?access[_-]?token|access[_-]?token[_-]?invalid|invalid[_-]?bearer[_-]?token|bearer[_-]?token[_-]?invalid|access[_-]?token[_-]?expired|invalid[_-]?token|token[_-]?invalid|token[_-]?expired)\b/i;

interface ValidationOptions {
  baseUrl?: string;
  apiProtocol?: ProviderProtocol;
  headers?: Record<string, string>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function normalizeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(
        ([key, value]): value is string =>
          typeof key === 'string'
          && key.trim().length > 0
          && typeof value === 'string'
          && value.trim().length > 0,
      )
      .map(([key, value]) => [key, value.trim()]),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeExtraHeaders(
  registryHeaders?: Record<string, string>,
  optionHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const base = normalizeHeaders(registryHeaders);
  const override = normalizeHeaders(optionHeaders);
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function buildOpenAiModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models?limit=1`;
}

function resolveOpenAiProbeUrls(
  baseUrl: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
): { modelsUrl: string; probeUrl: string } {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const endpointSuffixPattern = /(\/responses?|\/chat\/completions)$/i;
  const rootBase = normalizedBase.replace(endpointSuffixPattern, '');
  const modelsUrl = buildOpenAiModelsUrl(rootBase);

  if (apiProtocol === 'openai-responses') {
    const probeUrl = /(\/responses?)$/i.test(normalizedBase)
      ? normalizedBase
      : `${rootBase}/responses`;
    return { modelsUrl, probeUrl };
  }

  const probeUrl = /\/chat\/completions$/i.test(normalizedBase)
    ? normalizedBase
    : `${rootBase}/chat/completions`;
  return { modelsUrl, probeUrl };
}

function getValidationProfile(
  providerType: string,
  options?: ValidationOptions,
): ValidationProfile {
  const providerApi = options?.apiProtocol || getProviderConfig(providerType)?.api;

  if (providerApi === 'anthropic-messages') {
    return 'anthropic-header';
  }
  if (providerApi === 'openai-responses') {
    return 'openai-responses';
  }
  if (providerApi === 'openai-completions') {
    return 'openai-completions';
  }

  switch (providerType) {
    case 'google':
      return 'google-query-key';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'none';
    default:
      return 'openai-completions';
  }
}

function classifyAuthResponse(
  status: number,
  data?: unknown,
): ClassifiedValidationResult {
  const payload = data as {
    error?: { message?: string; code?: string };
    message?: string;
    code?: string;
  } | null;
  const payloadMessage = payload?.error?.message || payload?.message;
  const payloadCode = payload?.error?.code || payload?.code;
  const hasAuthCode = typeof payloadCode === 'string' && AUTH_ERROR_CODE_PATTERN.test(payloadCode);

  if (status >= 200 && status < 300) {
    return { valid: true };
  }
  if (status === 429) {
    return { valid: true };
  }
  if (status === 401 || status === 403) {
    return { valid: false, error: 'Invalid API key', authFailure: true };
  }
  if (status === 400 && ((typeof payloadMessage === 'string' && AUTH_ERROR_PATTERN.test(payloadMessage)) || hasAuthCode)) {
    const authError = hasAuthCode && !payloadMessage
      ? `Invalid API key (${payloadCode})`
      : (payloadMessage || 'Invalid API key');
    return { valid: false, error: authError, authFailure: true };
  }

  return {
    valid: false,
    error: payloadMessage ? `API error: ${String(status)} (${payloadMessage})` : `API error: ${String(status)}`,
  };
}

async function performProviderValidationRequest(
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => ({}));
    const result = classifyAuthResponse(response.status, data);
    return { ...result, status: response.status };
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function shouldFallbackFromModelsProbe(result: ClassifiedValidationResult): boolean {
  if (result.valid || result.status === undefined) {
    return false;
  }
  if (result.status === 401 || result.status === 403) {
    return false;
  }
  if (result.authFailure) {
    return false;
  }
  return true;
}

function classifyProbeResponse(
  status: number,
  data: unknown,
): ClassifiedValidationResult {
  const classified = classifyAuthResponse(status, data);
  if (status >= 200 && status < 300) {
    return { valid: true, status };
  }
  if (status === 429) {
    return { valid: true, status };
  }
  if (status === 400 && !classified.authFailure) {
    return { valid: true, status };
  }
  return { ...classified, status };
}

async function performResponsesProbe(
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        input: 'hi',
      }),
    });
    const data = await response.json().catch(() => ({}));
    return classifyProbeResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function performChatCompletionsProbe(
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    const data = await response.json().catch(() => ({}));
    return classifyProbeResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function performAnthropicMessagesProbe(
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    return classifyProbeResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateOpenAiCompatibleKey(
  providerType: string,
  apiKey: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
  baseUrl?: string,
  extraHeaders?: Record<string, string>,
): Promise<ValidationResult> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders ?? {}),
  };
  const { modelsUrl, probeUrl } = resolveOpenAiProbeUrls(trimmedBaseUrl, apiProtocol);
  const modelsResult = await performProviderValidationRequest(modelsUrl, headers);

  if (shouldFallbackFromModelsProbe(modelsResult)) {
    if (apiProtocol === 'openai-responses') {
      return await performResponsesProbe(probeUrl, headers);
    }
    return await performChatCompletionsProbe(probeUrl, headers);
  }

  return modelsResult;
}

async function validateGoogleQueryKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const url = `${base}/models?pageSize=1&key=${encodeURIComponent(apiKey)}`;
  return await performProviderValidationRequest(url, {});
}

async function validateAnthropicHeaderKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const rawBase = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const base = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
  const url = `${base}/models?limit=1`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const modelsResult = await performProviderValidationRequest(url, headers);
  if (modelsResult.status === 404 || modelsResult.status === 400) {
    const messageBase = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
    const probeUrl = `${messageBase}/messages`;
    return await performAnthropicMessagesProbe(probeUrl, headers);
  }

  return modelsResult;
}

async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  return await performProviderValidationRequest(
    'https://openrouter.ai/api/v1/auth/key',
    { Authorization: `Bearer ${apiKey}` },
  );
}

export async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: ValidationOptions,
): Promise<ValidationResult> {
  const profile = getValidationProfile(providerType, options);
  const registryConfig = getProviderConfig(providerType);
  const resolvedBaseUrl = options?.baseUrl || registryConfig?.baseUrl;
  const mergedHeaders = mergeExtraHeaders(registryConfig?.headers, options?.headers);
  const trimmedKey = apiKey.trim();

  if (profile === 'none') {
    return { valid: true };
  }

  if (!trimmedKey) {
    return { valid: false, error: 'API key is required' };
  }

  try {
    switch (profile) {
      case 'openai-completions':
        return await validateOpenAiCompatibleKey(
          providerType,
          trimmedKey,
          'openai-completions',
          resolvedBaseUrl,
          mergedHeaders,
        );
      case 'openai-responses':
        return await validateOpenAiCompatibleKey(
          providerType,
          trimmedKey,
          'openai-responses',
          resolvedBaseUrl,
          mergedHeaders,
        );
      case 'google-query-key':
        return await validateGoogleQueryKey(trimmedKey, resolvedBaseUrl);
      case 'anthropic-header':
        return await validateAnthropicHeaderKey(providerType, trimmedKey, resolvedBaseUrl);
      case 'openrouter':
        return await validateOpenRouterKey(trimmedKey);
      case 'none':
      default:
        return { valid: true };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
