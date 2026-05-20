import {
  assertOkOrThrowHttpError,
  postJsonRequest,
} from 'openclaw/plugin-sdk/provider-http'
import {
  collectOpenRouterImageSources,
  materializeImageSources,
} from '../image-sources.js'
import { protocolError } from '../errors.js'
import { resolveStringOption } from '../config.js'
import type { ImageProtocolHandler } from '../types.js'

function toDataUrl(image: NonNullable<Parameters<ImageProtocolHandler>[0]['req']['inputImages']>[number]): string {
  return `data:${image.mimeType};base64,${image.buffer.toString('base64')}`
}

function buildOpenRouterContent(req: Parameters<ImageProtocolHandler>[0]['req']): string | Array<Record<string, unknown>> {
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

export const generateOpenRouterImage: ImageProtocolHandler = async ({
  req,
  modelId,
  modelConfig,
  apiKey: _apiKey,
  http,
  timeoutMs,
}) => {
  const aspectRatio = resolveStringOption(req.aspectRatio, modelConfig?.aspectRatio)
  const resolution = resolveStringOption(req.resolution, modelConfig?.resolution)
  const { response, release } = await postJsonRequest({
    url: `${http.baseUrl}/chat/completions`,
    headers: http.headers,
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
    allowPrivateNetwork: http.allowPrivateNetwork,
    dispatcherPolicy: http.dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw OpenRouter-compatible image generation failed')
    const images = await materializeImageSources(
      collectOpenRouterImageSources(await response.json()),
      timeoutMs,
      fetch,
      {
        allowPrivateNetwork: http.allowPrivateNetwork,
        dispatcherPolicy: http.dispatcherPolicy,
      },
    )
    if (images.length === 0) {
      throw protocolError('MatchaClaw OpenRouter-compatible image generation response missing image data')
    }
    return { images, model: modelId }
  } finally {
    await release()
  }
}
