import path from 'node:path'
import type { TeamApproval, TeamApprovalStatus } from '../domain/team-approval.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileApprovalStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface RequestApprovalInput {
  runtimeRoot: string
  runId: string
  stageId: string
  roleId: string
  reason: string
  requestedAction: string
  risk: string
  idempotencyKey: string
}

export class FileApprovalStore {
  constructor(private readonly deps: FileApprovalStoreDeps) {}

  async request(input: RequestApprovalInput): Promise<{ approval: TeamApproval; created: boolean }> {
    return await this.withApprovalLock(input.runtimeRoot, async () => {
      const approvals = await this.read(input.runtimeRoot)
      const existing = approvals.find((approval) => approval.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { approval: existing, created: false }
      }

      const approval: TeamApproval = {
        approvalId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        stageId: input.stageId,
        roleId: input.roleId,
        reason: input.reason,
        requestedAction: input.requestedAction,
        risk: input.risk,
        status: 'pending',
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.approvalsPath(input.runtimeRoot), [...approvals, approval])
      return { approval, created: true }
    })
  }

  async resolve(input: {
    runtimeRoot: string
    approvalId: string
    status: Exclude<TeamApprovalStatus, 'pending'>
    note?: string
  }): Promise<{ approval: TeamApproval; resolved: boolean }> {
    return await this.withApprovalLock(input.runtimeRoot, async () => {
      const approvals = await this.read(input.runtimeRoot)
      const index = approvals.findIndex((approval) => approval.approvalId === input.approvalId)
      if (index < 0) {
        throw new Error(`Team approval not found: ${input.approvalId}`)
      }
      if (approvals[index].status !== 'pending') {
        return { approval: approvals[index], resolved: false }
      }

      const next: TeamApproval = {
        ...approvals[index],
        status: input.status,
        ...(input.note ? { note: input.note } : {}),
        resolvedAt: this.deps.clock.nowMs(),
      }
      const nextApprovals = [...approvals]
      nextApprovals[index] = next
      await atomicWriteJson(this.approvalsPath(input.runtimeRoot), nextApprovals)
      return { approval: next, resolved: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamApproval[]> {
    return await readJsonFile<TeamApproval[]>(this.approvalsPath(runtimeRoot)) ?? []
  }

  private async withApprovalLock<T>(runtimeRoot: string, task: () => Promise<T>): Promise<T> {
    return await withFileLock(path.join(runtimeRoot, 'locks', 'approvals.lock'), task)
  }

  private approvalsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'approvals', 'approvals.json')
  }
}
