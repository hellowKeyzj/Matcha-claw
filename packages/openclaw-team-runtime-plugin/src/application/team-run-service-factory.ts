import os from 'node:os'
import path from 'node:path'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { OpenClawRoleSessionExecution } from '../infrastructure/openclaw-role-session-execution.js'
import { OpenClawTaskFlowProjection, type PluginRuntimeTaskFlowsPort } from '../infrastructure/openclaw-task-flow-projection.js'
import { systemClock } from '../ports/clock-port.js'
import type { TeamDependencyCheckerPort } from '../ports/dependency-checker-port.js'
import { cryptoIdGenerator } from '../ports/id-generator-port.js'
import { TeamRunService } from './team-run-service.js'
import { TeamSkillPackageService } from './team-skill-package-service.js'

export interface TeamRunRuntimeServices {
  packageService: TeamSkillPackageService
  runService: TeamRunService
}

export function createTeamRunRuntimeServices(api: OpenClawPluginApi): TeamRunRuntimeServices {
  const packageService = new TeamSkillPackageService()
  const storageRoot = readStorageRoot(api)
  const taskFlows = readTaskFlows(api)
  return {
    packageService,
    runService: new TeamRunService({
      storageRoot,
      clock: systemClock,
      idGenerator: cryptoIdGenerator,
      packageService,
      ...(taskFlows ? { taskFlowProjection: new OpenClawTaskFlowProjection({ taskFlows, config: api.config, storageRoot }) } : {}),
      roleSessionExecution: new OpenClawRoleSessionExecution(api.runtime.subagent),
      dependencyChecker: readDependencyChecker(api),
    }),
  }
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

function readDependencyChecker(api: OpenClawPluginApi): TeamDependencyCheckerPort {
  const config = readPluginConfig(api)
  const availableSkills = new Set(readRequiredStringArray(config.availableSkills, 'availableSkills'))
  const availableTools = new Set(readRequiredStringArray(config.availableTools, 'availableTools'))
  return {
    async check(input) {
      return {
        missingRequiredSkills: input.requiredSkills.filter((skill) => !availableSkills.has(skill)),
        missingRequiredTools: input.requiredTools.filter((tool) => !availableTools.has(tool)),
        missingOptionalTools: input.optionalTools.filter((tool) => !availableTools.has(tool)),
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
