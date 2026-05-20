import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import type { ImageGenerationProvider } from 'openclaw/plugin-sdk/image-generation'
import {
  createPluginConfigContext,
  getConfiguredProviderKeys,
  resolveConfiguredModelRefs,
} from './config.js'
import { PLUGIN_ID } from './types.js'

const SUPPORTED_SIZES = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1024x1792',
  '1792x1024',
]
const SUPPORTED_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

let runtimePromise: Promise<typeof import('./runtime.js')> | null = null

async function loadRuntime(): Promise<typeof import('./runtime.js')> {
  if (!runtimePromise) {
    runtimePromise = import('./runtime.js')
  }
  return await runtimePromise
}

function buildImageProvider(api: OpenClawPluginApi): ImageGenerationProvider {
  const startupConfigContext = createPluginConfigContext(api.pluginConfig)
  const models = resolveConfiguredModelRefs(startupConfigContext)
  return {
    id: PLUGIN_ID,
    label: 'MatchaClaw Media',
    ...(models[0] ? { defaultModel: models[0] } : {}),
    models,
    isConfigured: (ctx) => getConfiguredProviderKeys(ctx).length > 0,
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
        sizes: [...SUPPORTED_SIZES],
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ['1K', '2K', '4K'],
      },
      output: {
        qualities: ['low', 'medium', 'high', 'auto'],
        formats: ['png', 'jpeg', 'webp'],
      },
    },
    generateImage: async (req) => (await loadRuntime()).generateImage(req),
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'MatchaClaw Media',
  description: 'Custom media generation providers configured by MatchaClaw.',
  register(api) {
    api.registerImageGenerationProvider(buildImageProvider(api))
  },
})
