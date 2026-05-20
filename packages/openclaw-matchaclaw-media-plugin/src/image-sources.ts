import {
  fetchWithTimeoutGuarded,
} from 'openclaw/plugin-sdk/provider-http'
import { isRecord, normalizeString } from './config.js'
import { MatchaClawMediaError, protocolError, timeoutError, upstreamError } from './errors.js'

const DEFAULT_OUTPUT_MIME = 'image/png'
const REMOTE_IMAGE_FETCH_MAX_ATTEMPTS = 3
const REMOTE_IMAGE_FETCH_RETRY_DELAY_MS = 750

type FetchFn = typeof fetch
type FetchGuardOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>

export type RequestNetworkPolicy = {
  allowPrivateNetwork: boolean
  dispatcherPolicy?: FetchGuardOptions['dispatcherPolicy']
}

export type ImageSource =
  | { type: 'base64'; data: string; mimeType?: string }
  | { type: 'dataUrl'; value: string }
  | { type: 'remoteUrl'; value: string }

export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  return mimeType.split('/')[1] ?? 'png'
}

export function toGeneratedImage(base64: string, index: number, mimeType = DEFAULT_OUTPUT_MIME) {
  return {
    buffer: Buffer.from(base64, 'base64'),
    mimeType,
    fileName: `image-${index + 1}.${extensionForMimeType(mimeType)}`,
  }
}

export type GeneratedImage = ReturnType<typeof toGeneratedImage>

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
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

export function extractImageUrlsFromText(text: string): string[] {
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

export function collectOpenAiImageSources(payload: unknown): ImageSource[] {
  const sources: ImageSource[] = []
  const root = isRecord(payload) ? payload : {}
  const data = Array.isArray(root.data) ? root.data : []
  for (const rawEntry of data) {
    if (!isRecord(rawEntry)) continue
    if (typeof rawEntry.b64_json === 'string') {
      sources.push({ type: 'base64', data: rawEntry.b64_json })
    }
    if (typeof rawEntry.url === 'string') {
      sources.push(parseDataUrl(rawEntry.url)
        ? { type: 'dataUrl', value: rawEntry.url }
        : { type: 'remoteUrl', value: rawEntry.url })
    }
  }
  return sources
}

export function collectOpenRouterImageSources(payload: unknown): ImageSource[] {
  const sources: ImageSource[] = []
  const root = isRecord(payload) ? payload : {}
  const choices = Array.isArray(root.choices) ? root.choices : []
  for (const choice of choices) {
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {}
    const images = Array.isArray(message.images) ? message.images : []
    for (const entry of images) {
      const imageUrl = isRecord(entry) && isRecord(entry.image_url)
        ? entry.image_url.url
        : isRecord(entry) && isRecord(entry.imageUrl)
          ? entry.imageUrl.url
          : undefined
      const url = typeof imageUrl === 'string' ? imageUrl : undefined
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

export function collectGoogleImageSources(payload: unknown): ImageSource[] {
  const sources: ImageSource[] = []
  const root = isRecord(payload) ? payload : {}
  const candidates = Array.isArray(root.candidates) ? root.candidates : []
  for (const candidate of candidates) {
    const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : {}
    const parts = Array.isArray(content.parts) ? content.parts : []
    for (const part of parts) {
      const inline = isRecord(part) && isRecord(part.inlineData)
        ? part.inlineData
        : isRecord(part) && isRecord(part.inline_data)
          ? part.inline_data
          : undefined
      const data = isRecord(inline) ? normalizeString(inline.data) : undefined
      if (data) {
        const mimeType = normalizeString(inline.mimeType) ?? normalizeString(inline.mime_type) ?? DEFAULT_OUTPUT_MIME
        sources.push({ type: 'base64', data, mimeType })
      }
      const text = isRecord(part) ? normalizeString(part.text) : undefined
      if (text) {
        for (const url of extractImageUrlsFromText(text)) {
          sources.push({ type: 'remoteUrl', value: url })
        }
      }
    }
  }
  return sources
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
          throw upstreamError(`MatchaClaw image URL fetch failed (HTTP ${response.status})`, response.status)
        }
        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || DEFAULT_OUTPUT_MIME
        if (!mimeType.startsWith('image/')) {
          throw protocolError('MatchaClaw image URL did not return image data')
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
      if (error instanceof MatchaClawMediaError && error.reason === 'format') {
        throw error
      }
      if (attempt < REMOTE_IMAGE_FETCH_MAX_ATTEMPTS) {
        await sleep(REMOTE_IMAGE_FETCH_RETRY_DELAY_MS * attempt)
      }
    }
  }
  const message = `MatchaClaw image URL fetch failed for ${formatRemoteImageUrlForLog(url)} after ${REMOTE_IMAGE_FETCH_MAX_ATTEMPTS} attempts: ${formatFetchError(lastError)}`
  if (formatFetchError(lastError).toLowerCase().includes('timeout')) {
    throw timeoutError(message, lastError)
  }
  throw upstreamError(message, undefined, lastError)
}

export async function materializeImageSources(
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
