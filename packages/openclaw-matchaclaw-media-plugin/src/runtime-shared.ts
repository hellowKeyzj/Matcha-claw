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
  buildHeaders,
  normalizeBaseUrl,
} from './http-runtime.js'
import {
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

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase()
}

function readAuthProfileApiKey(req: ResolvedImageRequest['req'], providerKey: string): string | undefined {
  const normalizedProvider = normalizeProviderKey(providerKey)
  const profiles = req.authStore?.profiles ?? {}
  const configuredOrder = req.authStore?.order?.[providerKey] ?? req.authStore?.order?.[normalizedProvider] ?? []
  const orderedIds = [
    ...configuredOrder,
    ...Object.keys(profiles).filter((profileId) => !configuredOrder.includes(profileId)),
  ]
  for (const profileId of orderedIds) {
    const profile = profiles[profileId]
    if (!profile || normalizeProviderKey(profile.provider ?? '') !== normalizedProvider) continue
    const value = profile.type === 'token' ? profile.token : profile.key
    const apiKey = typeof value === 'string' ? value.trim() : ''
    if (apiKey) return apiKey
  }
  return undefined
}

export async function resolveApiKey(
  req: ResolvedImageRequest['req'],
  providerKey: string,
  _provider: CustomMediaProviderConfig,
): Promise<string> {
  const storedApiKey = readAuthProfileApiKey(req, providerKey)
  if (storedApiKey) return storedApiKey
  const envKey = `MATCHACLAW_MEDIA_${providerKey.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
  const apiKey = process.env[envKey]?.trim() || process.env.MATCHACLAW_MEDIA_API_KEY?.trim() || ''
  if (!apiKey) throw authError(`MatchaClaw media provider "${providerKey}" API key missing`)
  return apiKey
}

export function resolveProviderHttpRuntime(
  provider: CustomMediaProviderConfig,
  input: {
    defaultHeaders: Record<string, string>
  },
): ProviderHttpRuntime {
  const baseUrl = normalizeBaseUrl(provider.baseUrl, provider.baseUrl)
  if (!baseUrl) throw protocolError('Missing MatchaClaw media provider baseUrl')
  return {
    baseUrl,
    headers: buildHeaders(input.defaultHeaders, provider.headers),
    allowPrivateNetwork: true,
  }
}

export function resolveGoogleHeaders(apiKey: string): Record<string, string> {
  return {
    'x-goog-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

export function ensureSupportedProtocol(provider: CustomMediaProviderConfig): void {
  if (provider.apiProtocol !== 'openai' && provider.apiProtocol !== 'google' && provider.apiProtocol !== 'openrouter') {
    throw protocolError(`Unsupported MatchaClaw media protocol: ${String(provider.apiProtocol)}`)
  }
}
