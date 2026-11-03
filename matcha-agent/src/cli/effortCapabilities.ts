import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setModelStrings,
} from '../bootstrap/state.js'
import { eagerParseCliFlag } from '../utils/cliArgs.js'
import { enableConfigs } from '../utils/config.js'
import { parseSettingSourcesFlag } from '../utils/settings/constants.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'

export async function printEffortCapabilities(args: string[]): Promise<void> {
  try {
    const modelArg = eagerParseCliFlag('--effort-capabilities', args)
    if (!modelArg || modelArg.startsWith('--')) {
      throw new Error('--effort-capabilities requires a model or default')
    }
    const sources = eagerParseCliFlag('--setting-sources', args)
    if (sources !== undefined) {
      setAllowedSettingSources(parseSettingSourcesFlag(sources))
    }
    const settings = eagerParseCliFlag('--settings', args)
    if (args.includes('--settings') && settings === undefined) {
      throw new Error('--settings requires a JSON object or settings file')
    }
    if (settings !== undefined) {
      const trimmed = settings.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed: unknown = JSON.parse(trimmed)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('--settings requires a JSON object or settings file')
        }
        setFlagSettingsInline(parsed as Record<string, unknown>)
      } else {
        const path = resolve(settings)
        readFileSync(path, 'utf8')
        setFlagSettingsPath(path)
      }
    }
    resetSettingsCache()
    enableConfigs()
    const {
      applySafeConfigEnvironmentVariables,
      applyConfigEnvironmentVariables,
    } = await import('../utils/managedEnv.js')
    applySafeConfigEnvironmentVariables()
    applyConfigEnvironmentVariables()

    const { getAPIProvider } = await import('../utils/model/providers.js')
    const { getBuiltinModelStrings } = await import(
      '../utils/model/modelStrings.js'
    )
    // Capability inspection must not start Bedrock inference-profile discovery.
    setModelStrings(getBuiltinModelStrings(getAPIProvider()))
    const { getMainLoopModel, parseUserSpecifiedModel } = await import(
      '../utils/model/model.js'
    )
    const {
      EFFORT_LEVELS,
      getInitialEffortSetting,
      getModelEffortCapabilities,
      isEffortLevel,
      resolveAdapterEffort,
    } = await import('../utils/effort.js')
    const effortArg = eagerParseCliFlag('--effort', args)?.toLowerCase()
    if (
      (args.includes('--effort') && effortArg === undefined) ||
      (effortArg !== undefined && !isEffortLevel(effortArg))
    ) {
      throw new Error(`--effort must be one of: ${EFFORT_LEVELS.join(', ')}`)
    }
    const model =
      modelArg === 'default'
        ? getMainLoopModel()
        : parseUserSpecifiedModel(modelArg)
    const capabilities = getModelEffortCapabilities(model)
    const effort = resolveAdapterEffort(
      model,
      effortArg ?? getInitialEffortSetting(),
    )
    console.log(
      JSON.stringify({
        model,
        ...capabilities,
        effectiveLevel: typeof effort === 'string' ? effort : null,
      }),
    )
  } catch (error) {
    console.error(
      `Error computing effort capabilities: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
