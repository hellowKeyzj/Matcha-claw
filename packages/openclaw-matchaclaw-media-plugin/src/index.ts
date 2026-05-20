import type { ImageGenerationProvider, ImageGenerationRequest } from 'openclaw/plugin-sdk/image-generation'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import {
  parseGeminiAuth,
  resolveApiKeyForProvider,
} from 'openclaw/plugin-sdk/image-generation-core'
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from 'openclaw/plugin-sdk/provider-http'

const PLUGIN_ID = 'matchaclaw-media'
const DEFAULT_OUTPUT_MIME = 'image/png'
const DEFAULT_TIMEOUT_MS = 180_000
const MIN_TIMEOUT_MS = 60_000
const DEFAULT_IMAGE_SIZE = '1024x1024'
const REMOTE_IMAGE_FETCH_MAX_ATTEMPTS = 3
const REMOTE_IMAGE_FETCH_RETRY_DELAY_MS = 750
const SUPPORTED_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

type CustomMediaProviderConfig = {
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

type CustomMediaPluginConfig = {
  providers?: Record<string, CustomMediaProviderConfig>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readPluginConfig(reqOrCtx: { cfg?: { plugins?: { entries?: Record<string, unknown> } } }): CustomMediaPluginConfig {
  const entry = reqOrCtx.cfg?.plugins?.entries?.[PLUGIN_ID]
  if (!isRecord(entry) || !isRecord(entry.config)) return {}
  return entry.config as CustomMediaPluginConfig
}

function parseRouteModel(value: string): { providerKey: string; modelId: string } {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`MatchaClaw media model must be "<credential>/<model>", received "${value}"`)
  }
  return {
    providerKey: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  }
}

function getProvider(req: ImageGenerationRequest): { providerKey: string; modelId: string; provider: CustomMediaProviderConfig } {
  const { providerKey, modelId } = parseRouteModel(req.model)
  const provider = readPluginConfig(req).providers?.[providerKey]
  if (!provider) {
    throw new Error(`MatchaClaw media provider "${providerKey}" is not configured`)
  }
  return { providerKey, modelId, provider }
}

function getConfiguredProviderKeys(ctx: { cfg?: { plugins?: { entries?: Record<string, unknown> } } }): string[] {
  return Object.keys(readPluginConfig(ctx).providers ?? {})
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  return mimeType.split('/')[1] ?? 'png'
}

function toGeneratedImage(base64: string, index: number, mimeType = DEFAULT_OUTPUT_MIME) {
  return {
    buffer: Buffer.from(base64, 'base64'),
    mimeType,
    fileName: `image-${index + 1}.${extensionForMimeType(mimeType)}`,
  }
}

type GeneratedImage = ReturnType<typeof toGeneratedImage>
type FetchFn = typeof fetch
type FetchGuardOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>
type RequestNetworkPolicy = {
  allowPrivateNetwork: boolean
  dispatcherPolicy?: FetchGuardOptions['dispatcherPolicy']
}
type ImageSource =
  | { type: 'base64'; data: string; mimeType?: string }
  | { type: 'dataUrl'; value: string }
  | { type: 'remoteUrl'; value: string }

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match || !match[1] || !match[2]) return null
  return { mimeType: match[1], data: match[2] }
}

function normalizeImageUrl(value: string): string | undefined {
  const trimmed = value.trim().replace(/[.,;]+$/g, '')
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function extractImageUrlsFromText(text: string): string[] {
  const urls = new Set<string>()
  for (const match of text.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/gi)) {
    const url = normalizeImageUrl(match[1] ?? '')
    if (url) urls.add(url)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?/gi)) {
    const url = normalizeImageUrl(match[0])
    if (url) urls.add(url)
  }
  return [...urls]
}

function resolveTimeoutMs(...values: unknown[]): number {
  let selected: number | undefined
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    const normalized = Math.floor(value)
    selected = selected === undefined ? normalized : Math.max(selected, normalized)
  }
  if (selected === undefined) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, selected)
}

function findConfiguredModel(provider: CustomMediaProviderConfig, modelId: string) {
  return provider.models?.find((model) => model.id === modelId)
}

function resolveStringOption(requestValue: unknown, modelValue: unknown): string | undefined {
  return normalizeString(requestValue) ?? normalizeString(modelValue)
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  let cause: unknown = error.cause
  const seen = new Set<unknown>([error])
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause)
    parts.push(`caused by ${cause.name}: ${cause.message}`)
    cause = cause.cause
  }
  if (cause !== undefined && !(cause instanceof Error)) {
    parts.push(`caused by ${String(cause)}`)
  }
  return parts.join(' | ')
}

function formatRemoteImageUrlForLog(value: string): string {
  try {
    const parsed = new URL(value)
    const query = parsed.search ? '?<query-redacted>' : ''
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`
  } catch {
    return '<invalid-url>'
  }
}

function resolveRemoteImageDispatcherPolicy(
  dispatcherPolicy: FetchGuardOptions['dispatcherPolicy'] | undefined,
): FetchGuardOptions['dispatcherPolicy'] | undefined {
  if (!dispatcherPolicy || !isRecord(dispatcherPolicy)) return undefined
  const mode = dispatcherPolicy.mode
  return mode === 'explicit-proxy' || mode === 'env-proxy'
    ? dispatcherPolicy
    : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchGeneratedImageUrl(
  url: string,
  index: number,
  timeoutMs: number,
  fetchFn: FetchFn,
  networkPolicy: RequestNetworkPolicy,
): Promise<GeneratedImage> {
  let lastError: unknown
  for (let attempt = 1; attempt <= REMOTE_IMAGE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const remoteImageDispatcherPolicy = resolveRemoteImageDispatcherPolicy(networkPolicy.dispatcherPolicy)
      const { response, release } = await fetchWithTimeoutGuarded(
        url,
        { method: 'GET' },
        timeoutMs,
        fetchFn,
        {
          auditContext: 'MatchaClaw image result',
          ...(networkPolicy.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(remoteImageDispatcherPolicy ? { dispatcherPolicy: remoteImageDispatcherPolicy } : {}),
        },
      )
      try {
        if (!response.ok) {
          throw new Error(`MatchaClaw image URL fetch failed (HTTP ${response.status})`)
        }
        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || DEFAULT_OUTPUT_MIME
        if (!mimeType.startsWith('image/')) {
          throw new Error('MatchaClaw image URL did not return image data')
        }
        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          mimeType,
          fileName: `image-${index + 1}.${extensionForMimeType(mimeType)}`,
        }
      } finally {
        await release()
      }
    } catch (error) {
      lastError = error
      if (attempt < REMOTE_IMAGE_FETCH_MAX_ATTEMPTS) {
        await sleep(REMOTE_IMAGE_FETCH_RETRY_DELAY_MS * attempt)
      }
    }
  }
  throw new Error(`MatchaClaw image URL fetch failed for ${formatRemoteImageUrlForLog(url)} after ${REMOTE_IMAGE_FETCH_MAX_ATTEMPTS} attempts: ${formatFetchError(lastError)}`)
}

async function materializeImageSources(
  sources: ImageSource[],
  timeoutMs: number,
  fetchFn: FetchFn,
  networkPolicy: RequestNetworkPolicy,
): Promise<GeneratedImage[]> {
  const images: GeneratedImage[] = []
  const seenRemoteUrls = new Set<string>()
  for (const source of sources) {
    if (source.type === 'base64') {
      images.push(toGeneratedImage(source.data, images.length, source.mimeType ?? DEFAULT_OUTPUT_MIME))
      continue
    }
    if (source.type === 'dataUrl') {
      const parsed = parseDataUrl(source.value)
      if (parsed) images.push(toGeneratedImage(parsed.data, images.length, parsed.mimeType))
      continue
    }
    const url = normalizeImageUrl(source.value)
    if (!url || seenRemoteUrls.has(url)) continue
    seenRemoteUrls.add(url)
    images.push(await fetchGeneratedImageUrl(url, images.length, timeoutMs, fetchFn, networkPolicy))
  }
  return images
}

function collectOpenAiImageSources(payload: any): ImageSource[] {
  const sources: ImageSource[] = []
  for (const entry of payload?.data ?? []) {
    if (typeof entry?.b64_json === 'string') {
      sources.push({ type: 'base64', data: entry.b64_json })
    }
    if (typeof entry?.url === 'string') {
      sources.push(parseDataUrl(entry.url)
        ? { type: 'dataUrl', value: entry.url }
        : { type: 'remoteUrl', value: entry.url })
    }
  }
  return sources
}

function collectOpenRouterImageSources(payload: any): ImageSource[] {
  const sources: ImageSource[] = []
  for (const choice of payload?.choices ?? []) {
    const message = choice?.message
    for (const entry of message?.images ?? []) {
      const url = entry?.image_url?.url ?? entry?.imageUrl?.url
      if (typeof url === 'string') {
        sources.push(parseDataUrl(url)
          ? { type: 'dataUrl', value: url }
          : { type: 'remoteUrl', value: url })
      }
    }
    const content = message?.content
    if (typeof content === 'string') {
      for (const match of content.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g)) {
        sources.push({ type: 'dataUrl', value: match[0] })
      }
      for (const url of extractImageUrlsFromText(content)) {
        sources.push({ type: 'remoteUrl', value: url })
      }
    }
  }
  return sources
}

function collectGoogleImageSources(payload: any): ImageSource[] {
  const sources: ImageSource[] = []
  for (const candidate of payload?.candidates ?? []) {
    for (const part of candidate?.content?.parts ?? []) {
      const inline = part?.inlineData ?? part?.inline_data
      const data = normalizeString(inline?.data)
      if (data) {
        const mimeType = normalizeString(inline?.mimeType) ?? normalizeString(inline?.mime_type) ?? DEFAULT_OUTPUT_MIME
        sources.push({ type: 'base64', data, mimeType })
      }
      const text = normalizeString(part?.text)
      if (text) {
        for (const url of extractImageUrlsFromText(text)) {
          sources.push({ type: 'remoteUrl', value: url })
        }
      }
    }
  }
  return sources
}

function buildHeaders(provider: CustomMediaProviderConfig, defaults: Record<string, string>): Headers {
  return new Headers({
    ...defaults,
    ...(provider.headers ?? {}),
  })
}

async function resolveApiKey(req: ImageGenerationRequest, providerKey: string, provider: CustomMediaProviderConfig): Promise<string> {
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
  return process.env[envKey]?.trim() || process.env.MATCHACLAW_MEDIA_API_KEY?.trim() || ''
}

function toDataUrl(image: NonNullable<ImageGenerationRequest['inputImages']>[number]): string {
  return `data:${image.mimeType};base64,${image.buffer.toString('base64')}`
}

function buildOpenRouterContent(req: ImageGenerationRequest): string | Array<Record<string, unknown>> {
  const inputImages = req.inputImages ?? []
  if (inputImages.length === 0) return req.prompt
  return [
    { type: 'text', text: req.prompt },
    ...inputImages.map((image) => ({
      type: 'image_url',
      image_url: { url: toDataUrl(image) },
    })),
  ]
}

async function generateGoogleImage(req: ImageGenerationRequest, providerKey: string, modelId: string, provider: CustomMediaProviderConfig, modelConfig?: NonNullable<CustomMediaProviderConfig['models']>[number]) {
  const apiKey = await resolveApiKey(req, providerKey, provider)
  if (!apiKey) throw new Error(`MatchaClaw media provider "${providerKey}" API key missing`)
  const defaultHeaders = parseGeminiAuth(apiKey).headers
  const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    baseUrl: provider.baseUrl,
    defaultBaseUrl: provider.baseUrl,
    defaultHeaders,
    provider: PLUGIN_ID,
    api: 'google-generative-ai',
    capability: 'image',
    transport: 'http',
    allowPrivateNetwork: true,
  })
  const headers = buildHeaders(provider, defaultHeaders)
  const inputParts = (req.inputImages ?? []).map((image) => ({
    inlineData: {
      mimeType: image.mimeType,
      data: image.buffer.toString('base64'),
    },
  }))
  const aspectRatio = resolveStringOption(req.aspectRatio, modelConfig?.aspectRatio)
  const resolution = resolveStringOption(req.resolution, modelConfig?.resolution)
  const imageConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { imageSize: resolution } : {}),
  }
  const timeoutMs = resolveTimeoutMs(req.timeoutMs, modelConfig?.timeoutMs)
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/models/${modelId}:generateContent`,
    headers,
    body: {
      contents: [{
        role: 'user',
        parts: [...inputParts, { text: req.prompt }],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
      },
    },
    timeoutMs,
    fetchFn: fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw Google-compatible image generation failed')
    const images = await materializeImageSources(
      collectGoogleImageSources(await response.json()),
      timeoutMs,
      fetch,
      { allowPrivateNetwork, dispatcherPolicy },
    )
    if (images.length === 0) throw new Error('MatchaClaw Google-compatible image generation response missing image data')
    return { images, model: modelId }
  } finally {
    await release()
  }
}

async function generateOpenAiImage(req: ImageGenerationRequest, providerKey: string, modelId: string, provider: CustomMediaProviderConfig, modelConfig?: NonNullable<CustomMediaProviderConfig['models']>[number]) {
  const apiKey = await resolveApiKey(req, providerKey, provider)
  if (!apiKey) throw new Error(`MatchaClaw media provider "${providerKey}" API key missing`)
  const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    baseUrl: provider.baseUrl,
    defaultBaseUrl: provider.baseUrl,
    defaultHeaders: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    provider: PLUGIN_ID,
    api: 'openai-responses',
    capability: 'image',
    transport: 'http',
    allowPrivateNetwork: true,
  })
  const headers = buildHeaders(provider, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' })
  const quality = resolveStringOption(req.quality, modelConfig?.quality)
  const timeoutMs = resolveTimeoutMs(req.timeoutMs, modelConfig?.timeoutMs)
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/images/generations`,
    headers,
    body: {
      model: modelId,
      prompt: req.prompt,
      n: typeof req.count === 'number' ? Math.max(1, Math.min(4, Math.trunc(req.count))) : 1,
      size: req.size ?? DEFAULT_IMAGE_SIZE,
      ...(quality ? { quality } : {}),
      ...(req.outputFormat ? { output_format: req.outputFormat } : {}),
    },
    timeoutMs,
    fetchFn: fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw OpenAI-compatible image generation failed')
    const images = await materializeImageSources(
      collectOpenAiImageSources(await response.json()),
      timeoutMs,
      fetch,
      { allowPrivateNetwork, dispatcherPolicy },
    )
    if (images.length === 0) throw new Error('MatchaClaw OpenAI-compatible image generation response missing image data')
    return { images, model: modelId }
  } finally {
    await release()
  }
}

async function generateOpenRouterImage(req: ImageGenerationRequest, providerKey: string, modelId: string, provider: CustomMediaProviderConfig, modelConfig?: NonNullable<CustomMediaProviderConfig['models']>[number]) {
  const apiKey = await resolveApiKey(req, providerKey, provider)
  if (!apiKey) throw new Error(`MatchaClaw media provider "${providerKey}" API key missing`)
  const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    baseUrl: provider.baseUrl,
    defaultBaseUrl: provider.baseUrl,
    defaultHeaders: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    provider: PLUGIN_ID,
    api: 'openai-completions',
    capability: 'image',
    transport: 'http',
    allowPrivateNetwork: true,
  })
  const headers = buildHeaders(provider, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' })
  const aspectRatio = resolveStringOption(req.aspectRatio, modelConfig?.aspectRatio)
  const resolution = resolveStringOption(req.resolution, modelConfig?.resolution)
  const timeoutMs = resolveTimeoutMs(req.timeoutMs, modelConfig?.timeoutMs)
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: {
      model: modelId,
      messages: [{ role: 'user', content: buildOpenRouterContent(req) }],
      modalities: ['image', 'text'],
      n: typeof req.count === 'number' ? Math.max(1, Math.min(4, Math.trunc(req.count))) : 1,
      ...(aspectRatio || resolution ? {
        image_config: {
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(resolution ? { image_size: resolution } : {}),
        },
      } : {}),
    },
    timeoutMs,
    fetchFn: fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw OpenRouter-compatible image generation failed')
    const images = await materializeImageSources(
      collectOpenRouterImageSources(await response.json()),
      timeoutMs,
      fetch,
      { allowPrivateNetwork, dispatcherPolicy },
    )
    if (images.length === 0) throw new Error('MatchaClaw OpenRouter-compatible image generation response missing image data')
    return { images, model: modelId }
  } finally {
    await release()
  }
}

function buildImageProvider(): ImageGenerationProvider {
  return {
    id: PLUGIN_ID,
    label: 'MatchaClaw Media',
    isConfigured: (ctx) => getConfiguredProviderKeys(ctx).length > 0,
    models: [],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ['1K', '2K', '4K'],
      },
      output: {
        qualities: ['low', 'medium', 'high', 'auto'],
        formats: ['png', 'jpeg', 'webp'],
      },
    },
    async generateImage(req) {
      const { providerKey, modelId, provider } = getProvider(req)
      const modelConfig = findConfiguredModel(provider, modelId)
      if (provider.apiProtocol === 'google') {
        return await generateGoogleImage(req, providerKey, modelId, provider, modelConfig)
      }
      if (provider.apiProtocol === 'openrouter') {
        return await generateOpenRouterImage(req, providerKey, modelId, provider, modelConfig)
      }
      return await generateOpenAiImage(req, providerKey, modelId, provider, modelConfig)
    },
  }
}

const plugin = {
  id: PLUGIN_ID,
  register(api: OpenClawPluginApi) {
    api.registerImageGenerationProvider(buildImageProvider())
  },
}

export default plugin
