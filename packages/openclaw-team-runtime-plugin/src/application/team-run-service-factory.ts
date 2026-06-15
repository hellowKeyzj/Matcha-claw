import os from 'node:os'
import path from 'node:path'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import type { TeamSkillDependencyEntry } from '../domain/team-skill-package.js'
import { OpenClawRoleSessionExecution } from '../infrastructure/openclaw-role-session-execution.js'
import { OpenClawTaskFlowProjection, type PluginRuntimeTaskFlowsPort } from '../infrastructure/openclaw-task-flow-projection.js'
import { systemClock } from '../ports/clock-port.js'
import type { TeamDependencyCheckerPort } from '../ports/dependency-checker-port.js'
import { cryptoIdGenerator } from '../ports/id-generator-port.js'
import { createTeamGatewayRequestPort } from '../gateway/team-gateway-methods.js'
import { type TeamRunContextPort } from './team-run-service.js'
import { TeamRunPluginRuntimeRegistry } from './team-run-plugin-runtime-registry.js'
import { TeamSkillPackageService } from './team-skill-package-service.js'

export { TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE } from './team-run-service.js'

const UNRESTRICTED_CAPABILITY_MARKER = '*'
const runtimeRegistryByApi = new WeakMap<OpenClawPluginApi, TeamRunPluginRuntimeRegistry>()

export function createTeamRunPluginRuntimeRegistry(api: OpenClawPluginApi): TeamRunPluginRuntimeRegistry {
  const existingRuntimeRegistry = runtimeRegistryByApi.get(api)
  if (existingRuntimeRegistry) {
    return existingRuntimeRegistry
  }

  const packageService = new TeamSkillPackageService()
  const storageRoot = readStorageRoot(api)
  const taskFlows = readTaskFlows(api)
  const runContext = readRunContext(api)
  const teamGatewayRequest = createTeamGatewayRequestPort(api)
  const createdRuntimeRegistry = new TeamRunPluginRuntimeRegistry({
    storageRoot,
    clock: systemClock,
    idGenerator: cryptoIdGenerator,
    packageService,
    ...(taskFlows ? { taskFlowProjection: new OpenClawTaskFlowProjection({ taskFlows, config: api.config, storageRoot }) } : {}),
    roleSessionExecution: new OpenClawRoleSessionExecution(api.runtime.subagent),
    teamGatewayRequest,
    ...(runContext ? { runContext } : {}),
    dependencyChecker: readDependencyChecker(api),
  })
  runtimeRegistryByApi.set(api, createdRuntimeRegistry)
  return createdRuntimeRegistry
}

function readStorageRoot(api: OpenClawPluginApi): string {
  const config = api.pluginConfig
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const storageRoot = (config as Record<string, unknown>).storageRoot
    if (typeof storageRoot === 'string' && storageRoot.trim()) {
      return storageRoot.trim()
    }
  }
  return path.join(os.tmpdir(), 'matchaclaw-team-runtime')
}

function readTaskFlows(api: OpenClawPluginApi): PluginRuntimeTaskFlowsPort | undefined {
  const runtime = api.runtime as unknown
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return undefined
  }
  const tasks = (runtime as { tasks?: unknown }).tasks
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    return undefined
  }
  const managedFlows = (tasks as { managedFlows?: unknown }).managedFlows
  if (!managedFlows || typeof managedFlows !== 'object' || Array.isArray(managedFlows)) {
    return undefined
  }
  const bindSession = (managedFlows as { bindSession?: unknown }).bindSession
  return typeof bindSession === 'function' ? managedFlows as PluginRuntimeTaskFlowsPort : undefined
}

function readRunContext(api: OpenClawPluginApi): TeamRunContextPort | undefined {
  const runContext = (api as { runContext?: unknown }).runContext
  if (!runContext || typeof runContext !== 'object' || Array.isArray(runContext)) {
    return undefined
  }
  const setRunContext = (runContext as { setRunContext?: unknown }).setRunContext
  return typeof setRunContext === 'function' ? runContext as TeamRunContextPort : undefined
}

function readDependencyChecker(api: OpenClawPluginApi): TeamDependencyCheckerPort {
  const config = readPluginConfig(api)
  const availableSkills = readAvailableCapabilitySet(config.availableSkills, 'availableSkills')
  const availableTools = readAvailableCapabilitySet(config.availableTools, 'availableTools')
  return {
    async check(input) {
      return {
        missingRequiredSkills: listMissingCapabilities(input.skills.filter((item) => item.required), availableSkills),
        missingOptionalSkills: listMissingCapabilities(input.skills.filter((item) => !item.required), availableSkills),
        missingRequiredTools: listMissingCapabilities(input.tools.filter((item) => item.required), availableTools),
        missingOptionalTools: listMissingCapabilities(input.tools.filter((item) => !item.required), availableTools),
      }
    },
  }
}

function readPluginConfig(api: OpenClawPluginApi): Record<string, unknown> {
  if (!api.pluginConfig || typeof api.pluginConfig !== 'object' || Array.isArray(api.pluginConfig)) {
    throw new Error('Team runtime pluginConfig must be an object with availableSkills and availableTools arrays.')
  }
  return api.pluginConfig
}

function readAvailableCapabilitySet(value: unknown, fieldName: string): Set<string> | null {
  const values = readRequiredStringArray(value, fieldName)
  return values.includes(UNRESTRICTED_CAPABILITY_MARKER) ? null : new Set(values)
}

function listMissingCapabilities(required: TeamSkillDependencyEntry[], available: Set<string> | null): TeamSkillDependencyEntry[] {
  if (!available) {
    return []
  }
  return required.filter((capability) => !available.has(capability.name))
}

function readRequiredStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Team runtime pluginConfig.${fieldName} must be an array of non-empty strings.`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Team runtime pluginConfig.${fieldName} must be an array of non-empty strings.`)
    }
    return item.trim()
  })
}
