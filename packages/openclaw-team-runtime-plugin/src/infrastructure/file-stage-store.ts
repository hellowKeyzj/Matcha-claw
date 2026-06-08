import path from 'node:path'
import type { TeamSkillWorkflowStageSpec } from '../domain/team-skill-package.js'
import type { TeamStage, TeamStageStatus } from '../domain/team-stage.js'
import type { ClockPort } from '../ports/clock-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileStageStoreDeps {
  clock: ClockPort
}

export class FileStageStore {
  constructor(private readonly deps: FileStageStoreDeps) {}

  async initialize(input: { runtimeRoot: string; runId: string; stages: TeamSkillWorkflowStageSpec[] }): Promise<TeamStage[]> {
    return await this.withStageLock(input.runtimeRoot, async () => {
      const existing = await this.read(input.runtimeRoot)
      if (existing.length > 0) {
        return existing
      }

      const now = this.deps.clock.nowMs()
      const stages = input.stages.map((stage) => ({
        runId: input.runId,
        stageId: stage.stageId,
        title: stage.title,
        executor: stage.executor,
        ...(stage.roleId ? { roleId: stage.roleId } : {}),
        ...(stage.gateType ? { gateType: stage.gateType } : {}),
        status: 'pending' as const,
        attempt: 0,
        maxAttempts: stage.maxAttempts,
        inputArtifactIds: [],
        outputArtifactIds: [],
        createdAt: now,
        updatedAt: now,
      }))
      await atomicWriteJson(this.stagesPath(input.runtimeRoot), stages)
      return stages
    })
  }

  async read(runtimeRoot: string): Promise<TeamStage[]> {
    return await readJsonFile<TeamStage[]>(this.stagesPath(runtimeRoot)) ?? []
  }

  async updateStatus(input: { runtimeRoot: string; stageId: string; status: TeamStageStatus; attempt?: number }): Promise<TeamStage> {
    return await this.withStageLock(input.runtimeRoot, async () => {
      const stages = await this.read(input.runtimeRoot)
      const index = stages.findIndex((stage) => stage.stageId === input.stageId)
      if (index < 0) {
        throw new Error(`Team stage not found: ${input.stageId}`)
      }

      const nextStage = this.updateStage(stages[index], {
        status: input.status,
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      })
      const nextStages = [...stages]
      nextStages[index] = nextStage
      await atomicWriteJson(this.stagesPath(input.runtimeRoot), nextStages)
      return nextStage
    })
  }

  async resumeWaitingStage(input: { runtimeRoot: string; stageId: string }): Promise<TeamStage> {
    return await this.withStageLock(input.runtimeRoot, async () => {
      const stages = await this.read(input.runtimeRoot)
      const index = stages.findIndex((stage) => stage.stageId === input.stageId)
      if (index < 0) {
        throw new Error(`Team stage not found: ${input.stageId}`)
      }
      if (stages[index].status !== 'waiting_for_user') {
        throw new Error(`Team stage is not waiting for user: ${input.stageId}`)
      }

      const nextStage = this.updateStage(stages[index], { status: 'running' })
      const nextStages = [...stages]
      nextStages[index] = nextStage
      await atomicWriteJson(this.stagesPath(input.runtimeRoot), nextStages)
      return nextStage
    })
  }

  async completeStage(input: {
    runtimeRoot: string
    stageId: string
    outputArtifactIds?: string[]
  }): Promise<{ stage: TeamStage; nextStage?: TeamStage; completed: boolean; changed: boolean }> {
    return await this.withStageLock(input.runtimeRoot, async () => {
      const stages = await this.read(input.runtimeRoot)
      const index = stages.findIndex((stage) => stage.stageId === input.stageId)
      if (index < 0) {
        throw new Error(`Team stage not found: ${input.stageId}`)
      }
      const existingNextStage = stages[index + 1]
      if (stages[index].status === 'passed') {
        return {
          stage: stages[index],
          ...(existingNextStage && existingNextStage.status === 'running' ? { nextStage: existingNextStage } : {}),
          completed: !existingNextStage,
          changed: false,
        }
      }
      if (stages[index].status !== 'running') {
        throw new Error(`Team stage is not running: ${input.stageId}`)
      }

      const nextStages = [...stages]
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        if (nextStages[previousIndex].status === 'running') {
          nextStages[previousIndex] = this.updateStage(nextStages[previousIndex], { status: 'passed' })
        }
      }

      const outputArtifactIds = Array.from(new Set([...stages[index].outputArtifactIds, ...(input.outputArtifactIds ?? [])]))
      const current = this.updateStage(stages[index], { status: 'passed', outputArtifactIds })
      nextStages[index] = current

      let nextStage: TeamStage | undefined
      const candidate = nextStages[index + 1]
      if (candidate && candidate.status === 'pending') {
        nextStage = this.updateStage(candidate, {
          status: 'running',
          attempt: candidate.attempt + 1,
          inputArtifactIds: Array.from(new Set([...candidate.inputArtifactIds, ...outputArtifactIds])),
        })
        nextStages[index + 1] = nextStage
      }

      await atomicWriteJson(this.stagesPath(input.runtimeRoot), nextStages)
      return { stage: current, ...(nextStage ? { nextStage } : {}), completed: !candidate, changed: true }
    })
  }

  async applyGateTransition(input: {
    runtimeRoot: string
    stageId: string
    artifactId: string
    passed: boolean
  }): Promise<{ stage: TeamStage; nextStage?: TeamStage; exhausted: boolean; completed: boolean; changed: boolean }> {
    return await this.withStageLock(input.runtimeRoot, async () => {
      const stages = await this.read(input.runtimeRoot)
      const index = stages.findIndex((stage) => stage.stageId === input.stageId)
      if (index < 0) {
        throw new Error(`Team stage not found: ${input.stageId}`)
      }

      const currentStage = stages[index]
      const existingNextStage = stages[index + 1]
      if (currentStage.status === 'passed' || currentStage.status === 'waiting_for_user' || (!input.passed && currentStage.outputArtifactIds.includes(input.artifactId))) {
        return {
          stage: currentStage,
          ...(existingNextStage && existingNextStage.status === 'running' ? { nextStage: existingNextStage } : {}),
          exhausted: !input.passed && currentStage.status === 'waiting_for_user',
          completed: input.passed && !existingNextStage,
          changed: false,
        }
      }
      if (currentStage.status !== 'running') {
        throw new Error(`Team stage is not running: ${input.stageId}`)
      }

      const nextStages = [...stages]
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        if (nextStages[previousIndex].status === 'running') {
          nextStages[previousIndex] = this.updateStage(nextStages[previousIndex], { status: 'passed' })
        }
      }
      const exhausted = !input.passed && currentStage.attempt >= currentStage.maxAttempts
      const current = this.updateStage(currentStage, {
        status: input.passed ? 'passed' : exhausted ? 'waiting_for_user' : 'running',
        attempt: input.passed || exhausted ? currentStage.attempt : currentStage.attempt + 1,
        outputArtifactIds: Array.from(new Set([...currentStage.outputArtifactIds, input.artifactId])),
      })
      nextStages[index] = current

      let nextStage: TeamStage | undefined
      if (input.passed) {
        const nextIndex = index + 1
        const candidate = nextStages[nextIndex]
        if (candidate && candidate.status === 'pending') {
          nextStage = this.updateStage(candidate, {
            status: 'running',
            attempt: candidate.attempt + 1,
            inputArtifactIds: Array.from(new Set([...candidate.inputArtifactIds, input.artifactId])),
          })
          nextStages[nextIndex] = nextStage
        }
      }

      await atomicWriteJson(this.stagesPath(input.runtimeRoot), nextStages)
      return { stage: current, ...(nextStage ? { nextStage } : {}), exhausted, completed: input.passed && !nextStages[index + 1], changed: true }
    })
  }

  private updateStage(stage: TeamStage, patch: Partial<Omit<TeamStage, 'runId' | 'stageId' | 'createdAt'>>): TeamStage {
    return {
      ...stage,
      ...patch,
      updatedAt: this.deps.clock.nowMs(),
    }
  }

  private async withStageLock<T>(runtimeRoot: string, task: () => Promise<T>): Promise<T> {
    return await withFileLock(path.join(runtimeRoot, 'locks', 'stages.lock'), task)
  }

  private stagesPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'stages.json')
  }
}
