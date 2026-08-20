import { ipcMain } from 'electron';
import { proxyAwareFetch } from '../../utils/proxy-fetch';

type ProviderApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

type ProviderValidationOptions = Readonly<{
  baseUrl?: string;
  apiProtocol?: ProviderApiProtocol;
  headers?: Record<string, string>;
}>;

type ProviderValidationRequest = Readonly<{
  accountId?: string;
  vendorId: string;
  apiKey: string;
  options?: ProviderValidationOptions;
}>;

type ProviderValidationResult = Readonly<{ valid: boolean; error?: string }>;
type ValidationResponse = ProviderValidationResult & Readonly<{ status?: number; authFailure?: boolean }>;
type ValidationProfile =
  | 'openai-completions'
  | 'openai-responses'
  | 'google-query-key'
  | 'anthropic-header'
  | 'openrouter'
  | 'none';

const AUTH_ERROR_PATTERN = /\b(unauthorized|forbidden|access denied|invalid api key|api key invalid|incorrect api key|api key incorrect|authentication failed|auth failed|invalid credential|credential invalid|invalid signature|signature invalid|invalid access token|access token invalid|invalid bearer token|bearer token invalid|access token expired)\b|鉴权失败|認証失敗|认证失败|無效密鑰|无效密钥|密钥无效|密鑰無效|憑證無效|凭证无效/i;
const AUTH_ERROR_CODE_PATTERN = /\b(unauthorized|forbidden|access[_-]?denied|invalid[_-]?api[_-]?key|api[_-]?key[_-]?invalid|incorrect[_-]?api[_-]?key|api[_-]?key[_-]?incorrect|authentication[_-]?failed|auth[_-]?failed|invalid[_-]?credential|credential[_-]?invalid|invalid[_-]?signature|signature[_-]?invalid|invalid[_-]?access[_-]?token|access[_-]?token[_-]?invalid|invalid[_-]?bearer[_-]?token|bearer[_-]?token[_-]?invalid|access[_-]?token[_-]?expired|invalid[_-]?token|token[_-]?invalid|token[_-]?expired)\b/i;
const INVALID_API_KEY_ERROR = 'Invalid API key';
const VALIDATION_REQUEST_ERROR = 'Provider validation request failed';
const VALIDATION_TIMEOUT_ERROR = 'Provider validation timed out';
const VALIDATION_FAILED_ERROR = 'Provider validation failed';
const SAFE_HEADER_NAMES = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'http-referer',
  'x-title',
  'x-goog-api-client',
  'x-goog-user-project',
  'anthropic-beta',
]);

export function registerProviderValidationHandlers(): void {
  ipcMain.handle('providers:validateApiKey', async (_, input: unknown): Promise<ProviderValidationResult> => {
    const request = parseValidationRequest(input);
    if (!request) return { valid: false, error: 'Provider validation request is invalid' };

    return await validateApiKeyWithProvider(request.vendorId, request.apiKey, request.options);
  });
}

function parseValidationRequest(input: unknown): ProviderValidationRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (!isNonEmptyString(value.vendorId) || !isNonEmptyString(value.apiKey)) return undefined;
  if (value.accountId !== undefined && !isNonEmptyString(value.accountId)) return undefined;
  if (value.options !== undefined && !isValidationOptions(value.options)) return undefined;
  return {
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    vendorId: value.vendorId,
    apiKey: value.apiKey,
    ...(value.options === undefined ? {} : { options: value.options }),
  };
}

function isValidationOptions(value: unknown): value is ProviderValidationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  if (options.baseUrl !== undefined && typeof options.baseUrl !== 'string') return false;
  if (options.apiProtocol !== undefined && !isApiProtocol(options.apiProtocol)) return false;
  if (options.headers !== undefined && !isHeaders(options.headers)) return false;
  return true;
}

function isHeaders(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, headerValue]) => key.trim().length > 0 && typeof headerValue === 'string',
  );
}

function isApiProtocol(value: unknown): value is ProviderApiProtocol {
  return value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
    || value === 'google-generative-ai';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: ProviderValidationOptions,
): Promise<ProviderValidationResult> {
  const profile = getValidationProfile(providerType, options);
  if (profile === 'none') return { valid: true };

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return { valid: false, error: INVALID_API_KEY_ERROR };

  try {
    const baseUrl = resolveProviderBaseUrl(providerType, options?.baseUrl?.trim());
    const headers = normalizeHeaders(options?.headers);
    switch (profile) {
      case 'openai-completions':
        return await validateOpenAiCompatibleKey(providerType, trimmedKey, 'openai-completions', baseUrl, headers);
      case 'openai-responses':
        return await validateOpenAiCompatibleKey(providerType, trimmedKey, 'openai-responses', baseUrl, headers);
      case 'google-query-key':
        return await validateGoogleQueryKey(trimmedKey, baseUrl, headers);
      case 'anthropic-header':
        return await validateAnthropicHeaderKey(trimmedKey, baseUrl, headers);
      case 'openrouter':
        return await validateOpenRouterKey(trimmedKey, headers);
    }
  } catch (error) {
    return { valid: false, error: isAbortError(error) ? VALIDATION_TIMEOUT_ERROR : VALIDATION_REQUEST_ERROR };
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => SAFE_HEADER_NAMES.has(key.trim().toLowerCase()))
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
}

function getValidationProfile(providerType: string, options?: ProviderValidationOptions): ValidationProfile {
  switch (options?.apiProtocol) {
    case 'anthropic-messages': return 'anthropic-header';
    case 'google-generative-ai': return 'google-query-key';
    case 'openai-responses': return 'openai-responses';
    case 'openai-completions': return 'openai-completions';
  }

  switch (providerType) {
    case 'anthropic':
    case 'minimax-portal':
    case 'minimax-portal-cn':
      return 'anthropic-header';
    case 'google': return 'google-query-key';
    case 'openrouter': return 'openrouter';
    case 'ollama': return 'none';
    case 'openai': return 'openai-responses';
    default: return 'openai-completions';
  }
}

function resolveProviderBaseUrl(providerType: string, baseUrl?: string): string | undefined {
  if (baseUrl) return baseUrl;
  return {
    openai: 'https://api.openai.com/v1',
    'minimax-portal': 'https://api.minimax.io/anthropic',
    'minimax-portal-cn': 'https://api.minimaxi.com/anthropic',
    'qwen-portal': 'https://portal.qwen.ai/v1',
    ark: 'https://ark.cn-beijing.volces.com/api/v3',
    moonshot: 'https://api.moonshot.cn/v1',
    'moonshot-global': 'https://api.moonshot.ai/v1',
    siliconflow: 'https://api.siliconflow.cn/v1',
    deepseek: 'https://api.deepseek.com/v1',
  }[providerType];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveOpenAiProbeUrls(
  baseUrl: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
): { modelsUrl: string; probeUrl: string } {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const rootBase = normalizedBase.replace(/(\/responses?|\/chat\/completions)$/i, '');
  return {
    modelsUrl: `${rootBase}/models?limit=1`,
    probeUrl: apiProtocol === 'openai-responses'
      ? (/(\/responses?)$/i.test(normalizedBase) ? normalizedBase : `${rootBase}/responses`)
      : (/\/chat\/completions$/i.test(normalizedBase) ? normalizedBase : `${rootBase}/chat/completions`),
  };
}

async function validateOpenAiCompatibleKey(
  providerType: string,
  apiKey: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
  baseUrl: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<ProviderValidationResult> {
  if (!baseUrl) return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${apiKey}`,
  };
  const { modelsUrl, probeUrl } = resolveOpenAiProbeUrls(baseUrl, apiProtocol);
  const modelsResult = await performProviderValidationRequest(modelsUrl, headers);
  if (shouldFallbackFromModelsProbe(modelsResult)) {
    return apiProtocol === 'openai-responses'
      ? await performResponsesProbe(probeUrl, headers)
      : await performChatCompletionsProbe(probeUrl, headers);
  }
  return publicValidationResult(modelsResult);
}

async function validateGoogleQueryKey(
  apiKey: string,
  baseUrl: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<ProviderValidationResult> {
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  return publicValidationResult(await performProviderValidationRequest(
    `${base}/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
    extraHeaders,
  ));
}

async function validateAnthropicHeaderKey(
  apiKey: string,
  baseUrl: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<ProviderValidationResult> {
  const rawBase = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const base = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
  const headers = { ...extraHeaders, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const modelsResult = await performProviderValidationRequest(`${base}/models?limit=1`, headers);
  if (modelsResult.status === 404 || modelsResult.status === 400) {
    return publicValidationResult(await performAnthropicMessagesProbe(`${base}/messages`, headers));
  }
  return publicValidationResult(modelsResult);
}

async function validateOpenRouterKey(apiKey: string, extraHeaders: Record<string, string>): Promise<ProviderValidationResult> {
  return publicValidationResult(await performProviderValidationRequest(
    'https://openrouter.ai/api/v1/auth/key',
    { ...extraHeaders, Authorization: `Bearer ${apiKey}` },
  ));
}

async function performProviderValidationRequest(url: string, headers: Record<string, string>): Promise<ValidationResponse> {
  try {
    const response = await fetchWithTimeout(url, { headers });
    const data = await response.json().catch(() => ({}));
    return { ...classifyAuthResponse(response.status, data), status: response.status };
  } catch (error) {
    return {
      valid: false,
      error: isAbortError(error) ? VALIDATION_TIMEOUT_ERROR : VALIDATION_REQUEST_ERROR,
    };
  }
}

async function performResponsesProbe(url: string, headers: Record<string, string>): Promise<ProviderValidationResult> {
  return await performBodyProbe(url, headers, {
    model: 'validation-probe',
    input: 'hi',
  });
}

async function performChatCompletionsProbe(url: string, headers: Record<string, string>): Promise<ProviderValidationResult> {
  return await performBodyProbe(url, headers, {
    model: 'validation-probe',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  });
}

async function performAnthropicMessagesProbe(url: string, headers: Record<string, string>): Promise<ProviderValidationResult> {
  return await performBodyProbe(url, headers, {
    model: 'validation-probe',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

async function performBodyProbe(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ProviderValidationResult> {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return publicValidationResult(classifyProbeResponse(response.status, data));
  } catch (error) {
    return {
      valid: false,
      error: isAbortError(error) ? VALIDATION_TIMEOUT_ERROR : VALIDATION_REQUEST_ERROR,
    };
  }
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await proxyAwareFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function classifyProbeResponse(status: number, data: unknown): ValidationResponse {
  const classified = classifyAuthResponse(status, data);
  if (status >= 200 && status < 300) return { valid: true, status };
  if (status === 429) return { valid: true, status };
  if (status === 400 && !classified.authFailure) return { valid: true, status };
  return { ...classified, status };
}

function classifyAuthResponse(status: number, data: unknown): ValidationResponse {
  const payload = data as {
    error?: { message?: string; code?: string };
    message?: string;
    code?: string;
  } | null;
  const payloadMessage = payload?.error?.message || payload?.message;
  const payloadCode = payload?.error?.code || payload?.code;
  const authFailure = (typeof payloadMessage === 'string' && AUTH_ERROR_PATTERN.test(payloadMessage))
    || (typeof payloadCode === 'string' && AUTH_ERROR_CODE_PATTERN.test(payloadCode));

  if (status >= 200 && status < 300) return { valid: true };
  if (status === 429) return { valid: true };
  if (status === 401 || status === 403 || (status === 400 && authFailure)) {
    return { valid: false, error: INVALID_API_KEY_ERROR, authFailure: true };
  }
  return {
    valid: false,
    error: VALIDATION_FAILED_ERROR,
    authFailure,
  };
}

function shouldFallbackFromModelsProbe(result: ValidationResponse): boolean {
  return !result.valid
    && result.status !== undefined
    && result.status !== 401
    && result.status !== 403
    && !result.authFailure;
}

function publicValidationResult(result: ValidationResponse): ProviderValidationResult {
  return result.valid ? { valid: true } : { valid: false, error: result.error || VALIDATION_FAILED_ERROR };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
