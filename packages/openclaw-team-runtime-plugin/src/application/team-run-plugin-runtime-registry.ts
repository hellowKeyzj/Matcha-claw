import { TeamRunService, type TeamRunServiceDeps } from './team-run-service.js'
import { TeamSkillPackageService } from './team-skill-package-service.js'

export interface TeamRunPluginRuntimeRegistryDeps extends Omit<TeamRunServiceDeps, 'packageService'> {
  packageService: TeamSkillPackageService
}

export class TeamRunPluginRuntimeRegistry {
  readonly packageService: TeamSkillPackageService

  private readonly runServiceByRunId = new Map<string, TeamRunService>()

  constructor(private readonly deps: TeamRunPluginRuntimeRegistryDeps) {
    this.packageService = deps.packageService
  }

  serviceForRun(runId: string): TeamRunService {
    const normalizedRunId = normalizeRunId(runId)
    const existingRunService = this.runServiceByRunId.get(normalizedRunId)
    if (existingRunService) {
      return existingRunService
    }
    const createdRunService = this.createRunService()
    this.runServiceByRunId.set(normalizedRunId, createdRunService)
    return createdRunService
  }

  async createRun(input: {
    packagePath: string
    runId?: string
    idempotencyKey: string
  }): Promise<Awaited<ReturnType<TeamRunService['create']>>> {
    const requestedRunId = input.runId?.trim()
    if (requestedRunId) {
      return await this.serviceForRun(requestedRunId).create({
        packagePath: input.packagePath,
        runId: requestedRunId,
        idempotencyKey: input.idempotencyKey,
      })
    }

    const createdRunService = this.createRunService()
    const createdRun = await createdRunService.create(input)
    this.bindRunService(createdRun.runId, createdRunService)
    return createdRun
  }

  async planDependencies(input: {
    packagePath: string
  }): Promise<Awaited<ReturnType<TeamRunService['planDependencies']>>> {
    return await this.createRunService().planDependencies(input)
  }

  async deleteRun(input: {
    runId: string
  }): Promise<Awaited<ReturnType<TeamRunService['delete']>>> {
    const normalizedRunId = normalizeRunId(input.runId)
    try {
      return await this.serviceForRun(normalizedRunId).delete({ runId: normalizedRunId })
    } finally {
      this.runServiceByRunId.delete(normalizedRunId)
    }
  }

  private bindRunService(runId: string, runService: TeamRunService): TeamRunService {
    const normalizedRunId = normalizeRunId(runId)
    const existingRunService = this.runServiceByRunId.get(normalizedRunId)
    if (existingRunService) {
      return existingRunService
    }
    this.runServiceByRunId.set(normalizedRunId, runService)
    return runService
  }

  private createRunService(): TeamRunService {
    return new TeamRunService(this.buildRunServiceDeps())
  }

  private buildRunServiceDeps(): TeamRunServiceDeps {
    return {
      storageRoot: this.deps.storageRoot,
      clock: this.deps.clock,
      idGenerator: this.deps.idGenerator,
      packageService: this.deps.packageService,
      ...(this.deps.taskManagerProjection ? { taskManagerProjection: this.deps.taskManagerProjection } : {}),
      ...(this.deps.taskFlowProjection ? { taskFlowProjection: this.deps.taskFlowProjection } : {}),
      ...(this.deps.roleSessionExecution ? { roleSessionExecution: this.deps.roleSessionExecution } : {}),
      ...(this.deps.teamGatewayRequest ? { teamGatewayRequest: this.deps.teamGatewayRequest } : {}),
      ...(this.deps.runContext ? { runContext: this.deps.runContext } : {}),
      ...(this.deps.dependencyChecker ? { dependencyChecker: this.deps.dependencyChecker } : {}),
      ...(this.deps.maxArtifactContentBytes !== undefined ? { maxArtifactContentBytes: this.deps.maxArtifactContentBytes } : {}),
      ...(this.deps.maxMessageBodyBytes !== undefined ? { maxMessageBodyBytes: this.deps.maxMessageBodyBytes } : {}),
      ...(this.deps.staleDispatchExecutionMs !== undefined ? { staleDispatchExecutionMs: this.deps.staleDispatchExecutionMs } : {}),
      ...(this.deps.disableAutoDispatch !== undefined ? { disableAutoDispatch: this.deps.disableAutoDispatch } : {}),
    }
  }
}

function normalizeRunId(runId: string): string {
  const normalizedRunId = runId.trim()
  if (!normalizedRunId) {
    throw new Error('runId is required')
  }
  return normalizedRunId
}
