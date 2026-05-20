import type { ImageGenerationProviderConfiguredContext } from 'openclaw/plugin-sdk/image-generation'
import {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PLUGIN_ID,
  type CustomMediaPluginConfig,
  type CustomMediaProviderConfig,
} from './types.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function readPluginConfig(ctx: { cfg?: { plugins?: { entries?: Record<string, unknown> } } }): CustomMediaPluginConfig {
  const entry = ctx.cfg?.plugins?.entries?.[PLUGIN_ID]
  if (!isRecord(entry) || !isRecord(entry.config)) return {}
  return entry.config as CustomMediaPluginConfig
}

export function createPluginConfigContext(config: unknown): { cfg?: { plugins?: { entries?: Record<string, unknown> } } } {
  return {
    cfg: {
      plugins: {
        entries: {
          [PLUGIN_ID]: { config },
        },
      },
    },
  }
}

export function readProviderMap(ctx: ImageGenerationProviderConfiguredContext): Record<string, CustomMediaProviderConfig> {
  return readPluginConfig(ctx).providers ?? {}
}

export function getConfiguredProviderKeys(ctx: ImageGenerationProviderConfiguredContext): string[] {
  return Object.keys(readProviderMap(ctx))
}

export function resolveConfiguredModelRefs(ctx: ImageGenerationProviderConfiguredContext): string[] {
  const refs: string[] = []
  for (const [providerKey, provider] of Object.entries(readProviderMap(ctx))) {
    for (const model of provider.models ?? []) {
      const modelId = normalizeString(model.id)
      if (modelId && model.capabilities?.includes('imageGenerate')) {
        refs.push(`${providerKey}/${modelId}`)
      }
    }
  }
  return refs
}

export function parseRouteModel(value: string): { providerKey: string; modelId: string } {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`MatchaClaw media model must be "<provider>/<model>", received "${value}"`)
  }
  return {
    providerKey: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  }
}

export function findConfiguredModel(provider: CustomMediaProviderConfig, modelId: string) {
  return provider.models?.find((model) => model.id === modelId)
}

export function resolveStringOption(requestValue: unknown, modelValue: unknown): string | undefined {
  return normalizeString(requestValue) ?? normalizeString(modelValue)
}

export function resolveTimeoutMs(...values: unknown[]): number {
  let selected: number | undefined
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    const normalized = Math.floor(value)
    selected = selected === undefined ? normalized : Math.max(selected, normalized)
  }
  if (selected === undefined) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, selected)
}
