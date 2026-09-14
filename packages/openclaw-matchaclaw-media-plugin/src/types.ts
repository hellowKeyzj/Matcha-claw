import type { PinnedDispatcherPolicy, SsrFPolicy } from './http-runtime.js'

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

export type ImageGenerationProviderConfiguredContext = {
  cfg?: { plugins?: { entries?: Record<string, unknown> } }
  agentDir?: string
}

export type ImageGenerationSourceImage = {
  buffer: Buffer
  mimeType: string
  fileName?: string
  metadata?: Record<string, unknown>
}

export type ImageGenerationResolution = '1K' | '2K' | '4K'
export type ImageGenerationQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageGenerationOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageGenerationBackground = 'transparent' | 'opaque' | 'auto'

export type ImageGenerationRequest = {
  provider?: string
  model: string
  prompt: string
  cfg: { plugins?: { entries?: Record<string, unknown> } }
  agentDir?: string
  authStore?: {
    profiles?: Record<string, {
      type?: string
      provider?: string
      key?: string
      token?: string
    }>
    order?: Record<string, string[]>
  }
  timeoutMs?: number
  count?: number
  size?: string
  aspectRatio?: string
  resolution?: ImageGenerationResolution
  quality?: ImageGenerationQuality
  outputFormat?: ImageGenerationOutputFormat
  background?: ImageGenerationBackground
  inputImages?: ImageGenerationSourceImage[]
  providerOptions?: Record<string, unknown>
  ssrfPolicy?: SsrFPolicy
}

export type ImageGenerationProvider = {
  id: string
  aliases?: string[]
  label?: string
  defaultModel?: string
  defaultTimeoutMs?: number
  models?: string[]
  capabilities: {
    generate: {
      maxCount?: number
      supportsSize?: boolean
      supportsAspectRatio?: boolean
      supportsResolution?: boolean
    }
    edit: {
      enabled: boolean
      maxCount?: number
      maxInputImages?: number
      maxInputImagesByModel?: Readonly<Record<string, number>>
      maxInputImagesByModelPrefix?: Readonly<Record<string, number>>
      supportsSize?: boolean
      supportsAspectRatio?: boolean
      supportsResolution?: boolean
    }
    geometry?: {
      sizes?: string[]
      sizesByModel?: Record<string, string[]>
      aspectRatios?: string[]
      aspectRatiosByModel?: Record<string, string[]>
      resolutions?: ImageGenerationResolution[]
      resolutionsByModel?: Record<string, ImageGenerationResolution[]>
    }
    output?: {
      qualities?: ImageGenerationQuality[]
      formats?: ImageGenerationOutputFormat[]
      backgrounds?: ImageGenerationBackground[]
    }
  }
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean
  generateImage: (req: ImageGenerationRequest) => Promise<{
    images: Array<{
      buffer: Buffer
      mimeType: string
      fileName?: string
      revisedPrompt?: string
      metadata?: Record<string, unknown>
    }>
    model?: string
    metadata?: Record<string, unknown>
  }>
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
