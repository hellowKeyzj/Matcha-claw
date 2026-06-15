import path from 'node:path'
import type { TeamDispatchExecutionRecord } from '../domain/team-dispatch-execution.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileDispatchExecutionStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface ClaimDispatchExecutionInput {
  runtimeRoot: string
  runId: string
  dispatchId: string
  stageId: string
  roleId: string
  idempotencyKey: string
  childSessionKey?: string
  spawnMode?: 'run' | 'session'
}

export interface AttachDispatchExecutionInput {
  runtimeRoot: string
  executionRecordId: string
  executionId?: string
  childSessionKey?: string
  spawnMode?: 'run' | 'session'
}

export interface CompleteDispatchExecutionInput {
  runtimeRoot: string
  executionRecordId?: string
  dispatchId?: string
  reason?: string
}

const BLOCKING_DISPATCH_EXECUTION_STATUSES = new Set(['claimed', 'queued', 'completed'])

export class FileDispatchExecutionStore {
  constructor(private readonly deps: FileDispatchExecutionStoreDeps) {}

  async claim(input: ClaimDispatchExecutionInput): Promise<{ execution: TeamDispatchExecutionRecord; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const existing = executions.find((execution) => execution.idempotencyKey === input.idempotencyKey)
        ?? executions.find((execution) => execution.dispatchId === input.dispatchId && BLOCKING_DISPATCH_EXECUTION_STATUSES.has(execution.status))
      if (existing) {
        return { execution: existing, created: false }
      }

      const execution: TeamDispatchExecutionRecord = {
        executionRecordId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        dispatchId: input.dispatchId,
        stageId: input.stageId,
        roleId: input.roleId,
        status: 'claimed',
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), [...executions, execution])
      return { execution, created: true }
    })
  }

  async attachQueuedExecution(input: AttachDispatchExecutionInput): Promise<{ execution: TeamDispatchExecutionRecord; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const index = executions.findIndex((execution) => execution.executionRecordId === input.executionRecordId)
      if (index < 0) {
        throw new Error(`Team dispatch execution not found: ${input.executionRecordId}`)
      }
      const current = executions[index]
      if (current.status !== 'claimed') {
        return { execution: current, changed: false }
      }

      const next: TeamDispatchExecutionRecord = {
        ...current,
        executionId: input.executionId,
        childSessionKey: input.childSessionKey,
        spawnMode: input.spawnMode,
        status: 'queued',
      }
      const nextExecutions = [...executions]
      nextExecutions[index] = next
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), nextExecutions)
      return { execution: next, changed: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamDispatchExecutionRecord[]> {
    return await readJsonFile<TeamDispatchExecutionRecord[]>(this.executionsPath(runtimeRoot)) ?? []
  }

  async markCompleted(input: CompleteDispatchExecutionInput): Promise<{ execution?: TeamDispatchExecutionRecord; changed: boolean }> {
    if (!input.executionRecordId && !input.dispatchId) {
      throw new Error('Team dispatch execution completion requires executionRecordId or dispatchId')
    }
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const index = input.executionRecordId
        ? executions.findIndex((execution) => execution.executionRecordId === input.executionRecordId)
        : executions.findIndex((execution) => execution.dispatchId === input.dispatchId && (execution.status === 'claimed' || execution.status === 'queued' || execution.status === 'completed'))
      if (index < 0) {
        return { changed: false }
      }
      const current = executions[index]
      if (current.status === 'completed') {
        return { execution: current, changed: false }
      }
      if (current.status !== 'claimed' && current.status !== 'queued') {
        return { execution: current, changed: false }
      }
      const next: TeamDispatchExecutionRecord = {
        ...current,
        status: 'completed',
        ...(input.reason ? { statusReason: input.reason } : {}),
      }
      const nextExecutions = [...executions]
      nextExecutions[index] = next
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), nextExecutions)
      return { execution: next, changed: true }
    })
  }

  async markFailed(input: { runtimeRoot: string; executionRecordId: string; reason: string }): Promise<{ execution: TeamDispatchExecutionRecord; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const index = executions.findIndex((execution) => execution.executionRecordId === input.executionRecordId)
      if (index < 0) {
        throw new Error(`Team dispatch execution not found: ${input.executionRecordId}`)
      }
      const current = executions[index]
      if (current.status !== 'claimed' && current.status !== 'queued') {
        return { execution: current, changed: false }
      }
      const next: TeamDispatchExecutionRecord = {
        ...current,
        status: 'failed',
        statusReason: input.reason,
      }
      const nextExecutions = [...executions]
      nextExecutions[index] = next
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), nextExecutions)
      return { execution: next, changed: true }
    })
  }

  async markStale(input: { runtimeRoot: string; executionRecordId: string; reason: string }): Promise<{ execution: TeamDispatchExecutionRecord; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const index = executions.findIndex((execution) => execution.executionRecordId === input.executionRecordId)
      if (index < 0) {
        throw new Error(`Team dispatch execution not found: ${input.executionRecordId}`)
      }
      const current = executions[index]
      if (current.status !== 'claimed' && current.status !== 'queued') {
        return { execution: current, changed: false }
      }
      const next: TeamDispatchExecutionRecord = {
        ...current,
        status: 'stale',
        statusReason: input.reason,
        staleAt: this.deps.clock.nowMs(),
      }
      const nextExecutions = [...executions]
      nextExecutions[index] = next
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), nextExecutions)
      return { execution: next, changed: true }
    })
  }

  async cancelActive(input: { runtimeRoot: string; runId: string; stageId?: string; reason: string }): Promise<{ executions: TeamDispatchExecutionRecord[]; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'dispatch-executions.lock'), async () => {
      const executions = await this.read(input.runtimeRoot)
      const cancelled: TeamDispatchExecutionRecord[] = []
      const nextExecutions = executions.map((execution) => {
        if (execution.runId !== input.runId || (input.stageId && execution.stageId !== input.stageId) || (execution.status !== 'claimed' && execution.status !== 'queued')) {
          return execution
        }
        const next: TeamDispatchExecutionRecord = {
          ...execution,
          status: 'cancelled',
          statusReason: input.reason,
        }
        cancelled.push(next)
        return next
      })
      if (cancelled.length === 0) {
        return { executions: [], changed: false }
      }
      await atomicWriteJson(this.executionsPath(input.runtimeRoot), nextExecutions)
      return { executions: cancelled, changed: true }
    })
  }

  private executionsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'dispatches', 'executions.json')
  }
}
