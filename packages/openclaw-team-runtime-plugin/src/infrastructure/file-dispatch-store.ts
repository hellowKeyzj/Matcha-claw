import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TeamDispatchEnvelope } from '../domain/team-dispatch.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileDispatchStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface SaveDispatchInput {
  runtimeRoot: string
  runId: string
  stageId: string
  roleId: string
  prompt: string
  inputArtifactIds: string[]
  kickbackIds: string[]
  idempotencyKey: string
  workflowPlanId?: string
  dispatchGroupId?: string
  groupId?: string
  taskId?: string
}

export class FileDispatchStore {
  constructor(private readonly deps: FileDispatchStoreDeps) {}

  async save(input: SaveDispatchInput): Promise<{ dispatch: TeamDispatchEnvelope; prompt: string; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatches.lock'), async () => {
      const dispatches = await this.read(input.runtimeRoot)
      const existing = dispatches.find((dispatch) => dispatch.idempotencyKey === input.idempotencyKey)
        ?? dispatches.find((dispatch) => dispatch.runId === input.runId
          && dispatch.stageId === input.stageId
          && dispatch.roleId === input.roleId
          && dispatch.workflowPlanId === input.workflowPlanId
          && dispatch.dispatchGroupId === input.dispatchGroupId
          && dispatch.groupId === input.groupId
          && dispatch.taskId === input.taskId
          && stringArraysEqual(dispatch.inputArtifactIds, input.inputArtifactIds)
          && stringArraysEqual(dispatch.kickbackIds, input.kickbackIds))
      if (existing) {
        return { dispatch: existing, prompt: await this.readPrompt(input.runtimeRoot, existing), created: false }
      }

      const dispatchId = this.deps.idGenerator.randomId()
      const promptRef = path.join('dispatches', 'prompts', `${dispatchId}.md`)
      const dispatch: TeamDispatchEnvelope = {
        dispatchId,
        runId: input.runId,
        stageId: input.stageId,
        roleId: input.roleId,
        promptRef,
        inputArtifactIds: input.inputArtifactIds,
        kickbackIds: input.kickbackIds,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
        ...(input.workflowPlanId ? { workflowPlanId: input.workflowPlanId } : {}),
        ...(input.dispatchGroupId ? { dispatchGroupId: input.dispatchGroupId } : {}),
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }

      await mkdir(path.join(input.runtimeRoot, 'dispatches', 'prompts'), { recursive: true })
      await writeFile(path.join(input.runtimeRoot, promptRef), input.prompt, 'utf8')
      await atomicWriteJson(this.dispatchesPath(input.runtimeRoot), [...dispatches, dispatch])
      return { dispatch, prompt: input.prompt, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamDispatchEnvelope[]> {
    return await readJsonFile<TeamDispatchEnvelope[]>(this.dispatchesPath(runtimeRoot)) ?? []
  }

  async readPrompt(runtimeRoot: string, dispatch: TeamDispatchEnvelope): Promise<string> {
    return await readFile(path.join(runtimeRoot, dispatch.promptRef), 'utf8')
  }

  private dispatchesPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'dispatches', 'dispatches.json')
  }
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
