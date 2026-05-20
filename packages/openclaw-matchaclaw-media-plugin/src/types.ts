import type { ImageGenerationRequest } from 'openclaw/plugin-sdk/image-generation'
import type { PinnedDispatcherPolicy } from 'openclaw/plugin-sdk/ssrf-dispatcher'

export const PLUGIN_ID = 'matchaclaw-media'
export const DEFAULT_TIMEOUT_MS = 180_000
export const MIN_TIMEOUT_MS = 60_000
export const DEFAULT_IMAGE_SIZE = '1024x1024'

export type CustomMediaProviderConfig = {
  label?: string
  baseUrl: string
  apiProtocol: 'openai' | 'google' | 'openrouter'
  headers?: Record<string, string>
  models?: Array<{
    id: string
    capabilities?: string[]
    timeoutMs?: number
    aspectRatio?: string
    resolution?: string
    quality?: string
  }>
}

export type CustomMediaPluginConfig = {
  providers?: Record<string, CustomMediaProviderConfig>
}

export type CustomMediaModelConfig = NonNullable<CustomMediaProviderConfig['models']>[number]

export type ResolvedImageRequest = {
  req: ImageGenerationRequest
  providerKey: string
  modelId: string
  provider: CustomMediaProviderConfig
  modelConfig?: CustomMediaModelConfig
}

export type ProviderHttpRuntime = {
  baseUrl: string
  headers: Headers
  allowPrivateNetwork: boolean
  dispatcherPolicy?: PinnedDispatcherPolicy
}

export type ImageProtocolHandler = (input: ResolvedImageRequest & {
  apiKey: string
  http: ProviderHttpRuntime
  timeoutMs: number
}) => Promise<{
  images: Array<{
    buffer: Buffer
    mimeType: string
    fileName?: string
  }>
  model: string
}>

export type MediaErrorReason =
  | 'auth'
  | 'auth_permanent'
  | 'format'
  | 'rate_limit'
  | 'overloaded'
  | 'billing'
  | 'timeout'
  | 'model_not_found'
  | 'session_expired'
  | 'unknown'

export type MediaGenerationErrorOptions = ErrorOptions & {
  reason: MediaErrorReason
  provider?: string
  model?: string
  profileId?: string
  status?: number
  code?: string
  rawError?: string
}
