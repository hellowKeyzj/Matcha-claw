import { resolveTimeoutMs } from './config.js'
import { classifyUnknownError, protocolError } from './errors.js'
import {
  ensureSupportedProtocol,
  resolveApiKey,
  resolveGoogleHeaders,
  resolveImageRequest,
  resolveProviderHttpRuntime,
} from './runtime-shared.js'
import { generateGoogleImage } from './protocols/google.js'
import { generateOpenAiImage } from './protocols/openai.js'
import { generateOpenRouterImage } from './protocols/openrouter.js'
import type { ImageGenerationRequest, ImageProtocolHandler } from './types.js'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function resolveProtocolHandler(protocol: string): ImageProtocolHandler {
  if (protocol === 'google') return generateGoogleImage
  if (protocol === 'openrouter') return generateOpenRouterImage
  if (protocol === 'openai') return generateOpenAiImage
  throw protocolError(`Unsupported MatchaClaw media protocol: ${protocol}`)
}

function resolveProtocolHeaders(protocol: string, apiKey: string): Record<string, string> {
  if (protocol === 'google') return resolveGoogleHeaders(apiKey)
  return {
    Authorization: `Bearer ${apiKey}`,
    ...JSON_HEADERS,
  }
}

export async function generateImage(req: ImageGenerationRequest) {
  try {
    const resolved = resolveImageRequest(req)
    ensureSupportedProtocol(resolved.provider)
    const apiKey = await resolveApiKey(req, resolved.providerKey, resolved.provider)
    const http = resolveProviderHttpRuntime(resolved.provider, {
      defaultHeaders: resolveProtocolHeaders(resolved.provider.apiProtocol, apiKey),
    })
    const timeoutMs = resolveTimeoutMs(req.timeoutMs, resolved.modelConfig?.timeoutMs)
    const handler = resolveProtocolHandler(resolved.provider.apiProtocol)
    return await handler({
      ...resolved,
      apiKey,
      http,
      timeoutMs,
    })
  } catch (error) {
    throw classifyUnknownError(error)
  }
}
