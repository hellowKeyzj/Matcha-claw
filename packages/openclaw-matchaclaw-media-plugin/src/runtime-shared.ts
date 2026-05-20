import {
  parseGeminiAuth,
  resolveApiKeyForProvider,
} from 'openclaw/plugin-sdk/image-generation-core'
import { resolveProviderHttpRequestConfig } from 'openclaw/plugin-sdk/provider-http'
import {
  findConfiguredModel,
  parseRouteModel,
  readPluginConfig,
} from './config.js'
import {
  authError,
  modelNotFoundError,
  protocolError,
} from './errors.js'
import {
  PLUGIN_ID,
  type CustomMediaProviderConfig,
  type ProviderHttpRuntime,
  type ResolvedImageRequest,
} from './types.js'

export function resolveImageRequest(req: ResolvedImageRequest['req']): ResolvedImageRequest {
  const { providerKey, modelId } = parseRouteModel(req.model)
  const provider = readPluginConfig(req).providers?.[providerKey]
  if (!provider) {
    throw modelNotFoundError(`MatchaClaw media provider "${providerKey}" is not configured`)
  }
  const modelConfig = findConfiguredModel(provider, modelId)
  if (!modelConfig || !modelConfig.capabilities?.includes('imageGenerate')) {
    throw modelNotFoundError(`MatchaClaw media model "${providerKey}/${modelId}" is not configured for image generation`)
  }
  return {
    req,
    providerKey,
    modelId,
    provider,
    modelConfig,
  }
}

export async function resolveApiKey(
  req: ResolvedImageRequest['req'],
  providerKey: string,
  provider: CustomMediaProviderConfig,
): Promise<string> {
  const headerValue = provider.headers?.Authorization ?? provider.headers?.authorization ?? ''
  if (headerValue.trim()) return headerValue.replace(/^Bearer\s+/i, '').trim()
  const auth = await resolveApiKeyForProvider({
    provider: providerKey,
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
  })
  if (auth.apiKey) return auth.apiKey
  const envKey = `MATCHACLAW_MEDIA_${providerKey.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
  const apiKey = process.env[envKey]?.trim() || process.env.MATCHACLAW_MEDIA_API_KEY?.trim() || ''
  if (!apiKey) throw authError(`MatchaClaw media provider "${providerKey}" API key missing`)
  return apiKey
}

export function buildHeaders(provider: CustomMediaProviderConfig, defaults: Record<string, string>): Headers {
  return new Headers({
    ...defaults,
    ...(provider.headers ?? {}),
  })
}

export function resolveProviderHttpRuntime(
  provider: CustomMediaProviderConfig,
  input: {
    defaultHeaders: Record<string, string>
    api: string
  },
): ProviderHttpRuntime {
  const resolved = resolveProviderHttpRequestConfig({
    baseUrl: provider.baseUrl,
    defaultBaseUrl: provider.baseUrl,
    defaultHeaders: input.defaultHeaders,
    provider: PLUGIN_ID,
    api: input.api,
    capability: 'image',
    transport: 'http',
    allowPrivateNetwork: true,
  })
  return {
    baseUrl: resolved.baseUrl,
    headers: buildHeaders(provider, input.defaultHeaders),
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    dispatcherPolicy: resolved.dispatcherPolicy,
  }
}

export function resolveGoogleHeaders(apiKey: string): Record<string, string> {
  return parseGeminiAuth(apiKey).headers
}

export function ensureSupportedProtocol(provider: CustomMediaProviderConfig): void {
  if (provider.apiProtocol !== 'openai' && provider.apiProtocol !== 'google' && provider.apiProtocol !== 'openrouter') {
    throw protocolError(`Unsupported MatchaClaw media protocol: ${String(provider.apiProtocol)}`)
  }
}
