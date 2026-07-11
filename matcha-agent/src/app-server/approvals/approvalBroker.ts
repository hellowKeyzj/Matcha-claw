import { randomUUID } from 'node:crypto'
import type {
  ApprovalRecord,
  ApprovalStatus,
  WorkerApprovalDecision,
  WorkerApprovalRequest,
} from '../protocol/types.js'

export type ApprovalBrokerOptions = {
  createApprovalId?: () => string
  now?: () => Date
}

export type ApprovalCreateInput = {
  sessionId: string
  workerId: string
  request: WorkerApprovalRequest
}

export type ApprovalRespondInput = {
  sessionId: string
  approvalId: string
  optionId: string
  reason?: string
}

export type ApprovalTerminalStatus = Exclude<
  ApprovalStatus,
  { type: 'pending' }
>

export type ApprovalCreateResult = {
  resultType: 'created'
  approval: ApprovalRecord
}

export type ApprovalResponseValidationFailure =
  | { resultType: 'approvalNotFound'; approvalId: string }
  | {
      resultType: 'sessionMismatch'
      approval: ApprovalRecord
      sessionId: string
    }
  | { resultType: 'invalidOption'; approval: ApprovalRecord; optionId: string }

export type ApprovalAlreadyResolvedResult = {
  resultType: 'alreadyResolved'
  approval: ApprovalRecord
  status: ApprovalTerminalStatus
  decision: WorkerApprovalDecision
}

export type ApprovalPreparedResponseResult = {
  resultType: 'prepared'
  approval: ApprovalRecord
  status: ApprovalTerminalStatus
  decision: WorkerApprovalDecision
}

export type ApprovalPrepareResponseResult =
  | ApprovalPreparedResponseResult
  | ApprovalAlreadyResolvedResult
  | ApprovalResponseValidationFailure

export type ApprovalRespondResult =
  | {
      resultType: 'responded'
      approval: ApprovalRecord
      decision: WorkerApprovalDecision
    }
  | ApprovalAlreadyResolvedResult
  | ApprovalResponseValidationFailure

export type ApprovalCancelResult = {
  approval: ApprovalRecord
  decision: WorkerApprovalDecision
}

export type ApprovalRestoreResult =
  | { resultType: 'restored'; approval: ApprovalRecord }
  | { resultType: 'duplicateApproval'; approvalId: string }

type ResolvedApproval = {
  approval: ApprovalRecord
  decision: WorkerApprovalDecision
}

export class ApprovalBroker {
  private readonly createApprovalId: () => string
  private readonly now: () => Date
  private readonly approvalsById = new Map<string, ApprovalRecord>()
  private readonly pendingApprovalsById = new Map<string, ApprovalRecord>()
  private readonly terminalDecisionsByApprovalId = new Map<
    string,
    WorkerApprovalDecision
  >()

  constructor(options: ApprovalBrokerOptions = {}) {
    this.createApprovalId = options.createApprovalId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  create(input: ApprovalCreateInput): ApprovalCreateResult {
    const approval: ApprovalRecord = {
      approvalId: input.request.approvalId ?? this.createApprovalId(),
      sessionId: input.sessionId,
      runId: input.request.runId,
      workerId: input.workerId,
      toolCallId: input.request.toolCallId,
      toolName: input.request.toolName,
      prompt: input.request.prompt,
      options: input.request.options,
      status: { type: 'pending', requestedAt: this.now().toISOString() },
    }

    this.insertApproval(approval)
    return { resultType: 'created', approval }
  }

  restore(approval: ApprovalRecord): ApprovalRestoreResult {
    if (this.approvalsById.has(approval.approvalId)) {
      return {
        resultType: 'duplicateApproval',
        approvalId: approval.approvalId,
      }
    }

    this.insertApproval(approval)
    return { resultType: 'restored', approval }
  }

  prepareResponse(input: ApprovalRespondInput): ApprovalPrepareResponseResult {
    const approval = this.approvalsById.get(input.approvalId)
    if (!approval) {
      return { resultType: 'approvalNotFound', approvalId: input.approvalId }
    }
    if (approval.sessionId !== input.sessionId) {
      return {
        resultType: 'sessionMismatch',
        approval,
        sessionId: input.sessionId,
      }
    }
    if (isTerminalApprovalStatus(approval.status)) {
      return {
        resultType: 'alreadyResolved',
        approval,
        status: approval.status,
        decision: this.getTerminalDecision(approval, approval.status),
      }
    }

    const option = approval.options.find(
      item => item.optionId === input.optionId,
    )
    if (!option) {
      return { resultType: 'invalidOption', approval, optionId: input.optionId }
    }

    const decision: WorkerApprovalDecision = option.kind.startsWith('allow')
      ? { type: 'approved', optionId: option.optionId }
      : {
          type: 'denied',
          optionId: option.optionId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }
    const status: ApprovalTerminalStatus =
      decision.type === 'approved'
        ? {
            type: 'approved',
            resolvedAt: this.now().toISOString(),
            optionId: decision.optionId,
          }
        : {
            type: 'denied',
            resolvedAt: this.now().toISOString(),
            ...(decision.reason !== undefined
              ? { reason: decision.reason }
              : {}),
          }

    return { resultType: 'prepared', approval, status, decision }
  }

  commitResponse(
    prepared: ApprovalPreparedResponseResult,
  ): Extract<ApprovalRespondResult, { resultType: 'responded' }> {
    const resolved = this.resolveApproval(
      prepared.approval,
      prepared.status,
      prepared.decision,
    )
    return {
      resultType: 'responded',
      approval: resolved.approval,
      decision: resolved.decision,
    }
  }

  respond(input: ApprovalRespondInput): ApprovalRespondResult {
    const prepared = this.prepareResponse(input)
    if (prepared.resultType !== 'prepared') return prepared
    return this.commitResponse(prepared)
  }

  cancelByRun(runId: string): ApprovalCancelResult[] {
    return this.cancelMatching(approval => approval.runId === runId, {
      type: 'cancelled',
      reason: 'runCancelled',
    })
  }

  cancelByWorker(workerId: string): ApprovalCancelResult[] {
    return this.cancelMatching(approval => approval.workerId === workerId, {
      type: 'cancelled',
      reason: 'workerExited',
    })
  }

  get(approvalId: string): ApprovalRecord | undefined {
    return this.approvalsById.get(approvalId)
  }

  listPending(sessionId?: string): ApprovalRecord[] {
    const approvals = Array.from(this.pendingApprovalsById.values())
    if (sessionId === undefined) {
      return approvals
    }
    return approvals.filter(approval => approval.sessionId === sessionId)
  }

  private insertApproval(approval: ApprovalRecord): void {
    this.approvalsById.set(approval.approvalId, approval)
    if (approval.status.type === 'pending') {
      this.pendingApprovalsById.set(approval.approvalId, approval)
    } else if (isTerminalApprovalStatus(approval.status)) {
      this.terminalDecisionsByApprovalId.set(
        approval.approvalId,
        approvalStatusToWorkerDecision(approval.status),
      )
    }
  }

  private cancelMatching(
    matches: (approval: ApprovalRecord) => boolean,
    cancellation: {
      type: 'cancelled'
      reason: 'runCancelled' | 'workerExited'
    },
  ): ApprovalCancelResult[] {
    const cancelled: ApprovalCancelResult[] = []
    for (const approval of Array.from(this.pendingApprovalsById.values())) {
      if (!matches(approval)) {
        continue
      }

      const status: ApprovalTerminalStatus = {
        ...cancellation,
        resolvedAt: this.now().toISOString(),
      }
      const decision: WorkerApprovalDecision = {
        type: 'cancelled',
        reason: status.reason,
      }
      cancelled.push(this.resolveApproval(approval, status, decision))
    }
    return cancelled
  }

  private resolveApproval(
    approval: ApprovalRecord,
    status: ApprovalTerminalStatus,
    decision: WorkerApprovalDecision,
  ): ResolvedApproval {
    const resolvedApproval: ApprovalRecord = { ...approval, status }
    this.approvalsById.set(approval.approvalId, resolvedApproval)
    this.pendingApprovalsById.delete(approval.approvalId)
    this.terminalDecisionsByApprovalId.set(approval.approvalId, decision)
    return { approval: resolvedApproval, decision }
  }

  private getTerminalDecision(
    approval: ApprovalRecord,
    status: ApprovalTerminalStatus,
  ): WorkerApprovalDecision {
    const decision = this.terminalDecisionsByApprovalId.get(approval.approvalId)
    if (decision) {
      return decision
    }
    return approvalStatusToWorkerDecision(status)
  }
}

function isTerminalApprovalStatus(
  status: ApprovalStatus,
): status is ApprovalTerminalStatus {
  return status.type !== 'pending'
}

function approvalStatusToWorkerDecision(
  status: ApprovalTerminalStatus,
): WorkerApprovalDecision {
  switch (status.type) {
    case 'approved':
      return { type: 'approved', optionId: status.optionId }
    case 'denied':
      return {
        type: 'denied',
        optionId: '',
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
      }
    case 'cancelled':
      return { type: 'cancelled', reason: status.reason }
    case 'expired':
      return { type: 'cancelled', reason: 'expired' }
  }
}
