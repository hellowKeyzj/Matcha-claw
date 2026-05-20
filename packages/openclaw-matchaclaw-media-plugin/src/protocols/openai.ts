import {
  assertOkOrThrowHttpError,
  postJsonRequest,
} from 'openclaw/plugin-sdk/provider-http'
import {
  collectOpenAiImageSources,
  materializeImageSources,
} from '../image-sources.js'
import { protocolError } from '../errors.js'
import { resolveStringOption } from '../config.js'
import { DEFAULT_IMAGE_SIZE } from '../types.js'
import type { ImageProtocolHandler } from '../types.js'

function resolveOpenAiSize(req: Parameters<ImageProtocolHandler>[0]['req'], modelConfig: Parameters<ImageProtocolHandler>[0]['modelConfig']): string {
  return req.size
    ?? resolveStringOption(req.aspectRatio, modelConfig?.aspectRatio)
    ?? DEFAULT_IMAGE_SIZE
}

function assertSynchronousOpenAiImagePayload(payload: unknown): void {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const status = typeof root.status === 'string' ? root.status : ''
  if (root.object === 'generation.task' || status === 'queued' || status === 'in_progress') {
    throw protocolError('MatchaClaw OpenAI-compatible image generation returned an async task; configure a synchronous image endpoint.')
  }
}

export const generateOpenAiImage: ImageProtocolHandler = async ({
  req,
  modelId,
  modelConfig,
  apiKey: _apiKey,
  http,
  timeoutMs,
}) => {
  const quality = resolveStringOption(req.quality, modelConfig?.quality)
  const { response, release } = await postJsonRequest({
    url: `${http.baseUrl}/images/generations`,
    headers: http.headers,
    body: {
      model: modelId,
      prompt: req.prompt,
      n: typeof req.count === 'number' ? Math.max(1, Math.min(4, Math.trunc(req.count))) : 1,
      size: resolveOpenAiSize(req, modelConfig),
      ...(quality ? { quality } : {}),
      ...(req.outputFormat ? { output_format: req.outputFormat } : {}),
    },
    timeoutMs,
    fetchFn: fetch,
    allowPrivateNetwork: http.allowPrivateNetwork,
    dispatcherPolicy: http.dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw OpenAI-compatible image generation failed')
    const payload = await response.json()
    assertSynchronousOpenAiImagePayload(payload)
    const images = await materializeImageSources(
      collectOpenAiImageSources(payload),
      timeoutMs,
      fetch,
      {
        allowPrivateNetwork: http.allowPrivateNetwork,
        dispatcherPolicy: http.dispatcherPolicy,
      },
    )
    if (images.length === 0) {
      throw protocolError('MatchaClaw OpenAI-compatible image generation response missing image data')
    }
    return { images, model: modelId }
  } finally {
    await release()
  }
}
