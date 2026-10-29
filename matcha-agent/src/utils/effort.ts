// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { BetaOutputConfig } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { createHash } from 'crypto'
import { normalizeModelStringForAPI } from './model/configs.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import { safeParseJSON } from './json.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { resolveAntModel } from './model/antModels.js'
import { getAntModelOverrideConfig } from './model/antModels.js'
import {
  isChatGPTAuthMode,
  isChatGPTCodexReasoningModel,
} from './model/chatgptModels.js'

export type { EffortLevel }

// NOTE: 'ultracode' is NOT an effort level. It is a session-scoped multi-agent
// orchestration opt-in injected by the harness (claude.ai/client) as a
// system-reminder, orthogonal to the effort parameter. EffortLevel / EffortValue
// must never include 'ultracode'; /effort only accepts the levels below.
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
function effortSupport(model: string): { supported: boolean; source: string } {
  const provider = getAPIProvider()
  if (provider === 'openaiResponses') return { supported: true, source: 'responses_contract' }
  if (provider === 'openai' && isChatGPTAuthMode()) return { supported: true, source: 'chatgpt_responses_contract' }
  if (provider === 'gemini' || provider === 'grok') return { supported: false, source: 'provider_route_unsupported' }
  if (provider === 'openai') {
    const override = get3PModelCapabilityOverride(normalizeModelStringForAPI(model), 'effort')
    return { supported: override === true, source: override === undefined ? 'capability_unknown' : 'model_capability_override' }
  }

  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return { supported: true, source: 'always_enable_override' }
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return { supported: supported3P, source: 'model_capability_override' }
  }
  // Supported by a subset of Claude 4 models
  if (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('deepseek-v4-pro')
  ) {
    return { supported: true, source: 'model_allowlist' }
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return { supported: false, source: 'legacy_model' }
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return { supported: provider === 'firstParty', source: provider === 'firstParty' ? 'first_party_default' : 'capability_unknown' }
}

export function modelSupportsEffort(model: string): boolean {
  return effortSupport(model).supported
}

// Generic completions need explicit capability facts for extended levels.
// Other routes retain their existing max/xhigh defaults.
export function modelSupportsMaxEffort(_model: string): boolean {
  const model = getAPIProvider() === 'openai' && !isChatGPTAuthMode() ? normalizeModelStringForAPI(_model) : _model
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  return getAPIProvider() !== 'openai' || isChatGPTAuthMode()
}

export function modelSupportsXhighEffort(_model: string): boolean {
  const model = getAPIProvider() === 'openai' && !isChatGPTAuthMode() ? normalizeModelStringForAPI(_model) : _model
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  return getAPIProvider() !== 'openai' || isChatGPTAuthMode()
}

export function getModelEffortCapabilities(model: string): {
  supportsEffort: boolean
  supportedEffortLevels: EffortLevel[]
} {
  const supportsEffort = modelSupportsEffort(model)
  const provider = getAPIProvider()
  const usesResponses =
    provider === 'openaiResponses' ||
    (provider === 'openai' && isChatGPTAuthMode())
  return {
    supportsEffort,
    supportedEffortLevels: supportsEffort
      ? EFFORT_LEVELS.filter(
          level =>
            usesResponses ||
            ((level !== 'max' || modelSupportsMaxEffort(model)) &&
              (level !== 'xhigh' || modelSupportsXhighEffort(model))),
        )
      : [],
  }
}

export function resolveAnthropicEffort(
  model: string,
  effortValue: EffortValue | undefined,
  extraBodyParams: unknown,
): {
  outputConfig: BetaOutputConfig
  includeBeta: boolean
  effortOverride: number | undefined
} {
  const extraBody =
    extraBodyParams &&
    typeof extraBodyParams === 'object' &&
    !Array.isArray(extraBodyParams)
      ? (extraBodyParams as Record<string, unknown>)
      : {}
  const outputConfig: BetaOutputConfig = {
    ...((extraBody.output_config as BetaOutputConfig) ?? {}),
  }
  let includeBeta = false
  let effortOverride: number | undefined
  if (modelSupportsEffort(model) && !('effort' in outputConfig)) {
    if (effortValue === undefined) {
      includeBeta = true
    } else if (typeof effortValue === 'string') {
      outputConfig.effort = effortValue as 'high' | 'medium' | 'low' | 'max'
      includeBeta = true
    } else if (process.env.USER_TYPE === 'ant') {
      effortOverride = effortValue
    }
  }
  return { outputConfig, includeBeta, effortOverride }
}

/** The adapter's outgoing parameter, not proof the remote model accepts it. */
export function resolveAdapterEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const provider = getAPIProvider()
  if (
    provider === 'openaiResponses' ||
    (provider === 'openai' && isChatGPTAuthMode())
  ) {
    const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
    if (envOverride === 'auto' || envOverride === 'unset') return undefined
    if (envOverride && isEffortLevel(envOverride)) return envOverride
    if (typeof appStateEffortValue === 'number') return 'high'
    if (appStateEffortValue && isEffortLevel(appStateEffortValue)) return appStateEffortValue
    return provider === 'openai' ? 'medium' : undefined
  }
  if (provider === 'openai') {
    const value = resolveAppliedEffort(model, appStateEffortValue)
    if (value === undefined) return undefined
    const level = convertEffortValueToLevel(value)
    return getModelEffortCapabilities(model).supportedEffortLevels.includes(level)
      ? level
      : undefined
  }
  if (provider === 'gemini' || provider === 'grok') return undefined

  const { outputConfig, effortOverride } = resolveAnthropicEffort(
    model,
    resolveAppliedEffort(model, appStateEffortValue),
    safeParseJSON(process.env.CLAUDE_CODE_EXTRA_BODY ?? '', false),
  )
  const effort: unknown = outputConfig.effort ?? effortOverride
  return typeof effort === 'number' ||
    (typeof effort === 'string' && isEffortLevel(effort))
    ? effort
    : undefined
}

export function traceEffort(
  reason: 'control_invalid' | 'control_unsupported' | 'control_applied' | 'settings_read' | 'sender_request',
  model: string,
  requested: EffortValue | null | undefined,
  details: {
    requestId?: string
    level?: EffortValue | null
    actual?: EffortValue | null
    senderField?: 'reasoning_effort' | 'reasoning.effort' | 'output_config.effort' | 'anthropic_internal.effort_override'
    applied?: boolean
    persisted?: boolean
  } = {},
): void {
  if (process.env.MATCHACLAW_TRACE !== '1') return
  try {
    const provider = getAPIProvider()
    const responses = provider === 'openaiResponses' || (provider === 'openai' && isChatGPTAuthMode())
    const protocol = responses ? 'responses' : provider === 'openai' ? 'chat_completions' : provider === 'gemini' ? 'gemini' : provider === 'grok' ? 'grok' : 'anthropic'
    const support = effortSupport(model)
    const rawEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
    const env = responses
      ? rawEnv === 'auto' || rawEnv === 'unset' ? null : rawEnv && isEffortLevel(rawEnv) ? rawEnv : undefined
      : getEffortEnvOverride()
    const extraBody = !responses && protocol === 'anthropic'
      ? safeParseJSON(process.env.CLAUDE_CODE_EXTRA_BODY ?? '', false)
      : undefined
    const outputConfig = extraBody && typeof extraBody === 'object' && 'output_config' in extraBody ? extraBody.output_config : undefined
    const source = outputConfig && typeof outputConfig === 'object' && 'effort' in outputConfig
      ? 'extra_body'
      : env === null ? 'env_disabled' : env !== undefined ? 'env_override' : requested != null ? 'app_state' : 'model_default'
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const safeLevel = (value: unknown) => (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && isEffortLevel(value)) ? value : null
    logForDebugging(`[thinking] ${JSON.stringify({
      reason, provider, protocol,
      sessionHash: hash(getSessionId()),
      modelHash: hash(provider === 'openai' && !responses ? normalizeModelStringForAPI(model) : model),
      requestHash: details.requestId ? hash(details.requestId) : undefined,
      requested: safeLevel(requested),
      level: safeLevel(details.level === undefined ? requested : details.level),
      ...getModelEffortCapabilities(model),
      capabilitySource: support.source,
      effective: safeLevel(resolveAdapterEffort(model, requested ?? undefined)),
      source,
      actual: safeLevel(details.actual),
      senderField: details.senderField,
      applied: details.applied,
      persisted: details.persisted,
    })}`, { matchaTrace: true })
  } catch {
    // Diagnostic failures must not change the setting or request result.
  }
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  return envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Extended reasoning beyond high, short of max'
    case 'max':
      return 'Maximum capability with deepest reasoning'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === (config.defaultModel as string).toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel as EffortValue
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  if (
    getAPIProvider() === 'openai' &&
    isChatGPTAuthMode() &&
    isChatGPTCodexReasoningModel(model)
  ) {
    return 'medium'
  }

  // Default effort on Opus 4.6 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (
    model.toLowerCase().includes('opus-4-7') ||
    model.toLowerCase().includes('opus-4-6')
  ) {
    if (isProSubscriber()) {
      return 'high'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'high'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
