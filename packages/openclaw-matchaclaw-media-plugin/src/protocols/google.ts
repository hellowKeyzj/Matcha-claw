import {
  assertOkOrThrowHttpError,
  postJsonRequest,
} from 'openclaw/plugin-sdk/provider-http'
import {
  collectGoogleImageSources,
  materializeImageSources,
} from '../image-sources.js'
import { protocolError } from '../errors.js'
import { resolveStringOption } from '../config.js'
import type { ImageProtocolHandler } from '../types.js'

export const generateGoogleImage: ImageProtocolHandler = async ({
  req,
  modelId,
  modelConfig,
  apiKey: _apiKey,
  http,
  timeoutMs,
}) => {
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
  const { response, release } = await postJsonRequest({
    url: `${http.baseUrl}/models/${modelId}:generateContent`,
    headers: http.headers,
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
    allowPrivateNetwork: http.allowPrivateNetwork,
    ssrfPolicy: req.ssrfPolicy,
    dispatcherPolicy: http.dispatcherPolicy,
  })
  try {
    await assertOkOrThrowHttpError(response, 'MatchaClaw Google-compatible image generation failed')
    const images = await materializeImageSources(
      collectGoogleImageSources(await response.json()),
      timeoutMs,
      fetch,
      {
        allowPrivateNetwork: http.allowPrivateNetwork,
        dispatcherPolicy: http.dispatcherPolicy,
      },
    )
    if (images.length === 0) {
      throw protocolError('MatchaClaw Google-compatible image generation response missing image data')
    }
    return { images, model: modelId }
  } finally {
    await release()
  }
}
