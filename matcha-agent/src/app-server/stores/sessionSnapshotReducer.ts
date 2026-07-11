import type {
  AppServerEventEnvelope,
  ApprovalRecord,
  RunRecord,
  RunStatus,
  SessionRecord,
  SessionSnapshot,
} from '../protocol/types.js'

export function reduceSessionSnapshot(
  prev: SessionSnapshot | undefined,
  envelope: AppServerEventEnvelope,
): SessionSnapshot | undefined {
  if (
    envelope.event.type === 'session.created' ||
    envelope.event.type === 'session.loaded'
  ) {
    const snapshot = prev ?? emptySnapshot(envelope.event.session)
    return withEnvelopeVersion(
      {
        ...snapshot,
        session: withConversation(envelope.event.session, snapshot.session),
      },
      envelope,
    )
  }

  if (!prev) return undefined

  switch (envelope.event.type) {
    case 'run.queued':
      return withEnvelopeVersion(
        {
          ...prev,
          session: { ...prev.session, hasConversation: true },
          runs: upsertRun(prev.runs, envelope.event.run),
        },
        envelope,
      )

    case 'run.started':
      return withEnvelopeVersion(
        {
          ...prev,
          runs: updateRunStatus(prev.runs, envelope.event.runId, {
            type: 'running',
            startedAt: envelope.createdAt,
            workerId: envelope.event.workerId,
          }),
        },
        envelope,
      )

    case 'run.trace':
      return withEnvelopeVersion(
        {
          ...prev,
          messages: [...prev.messages, envelope],
        },
        envelope,
      )

    case 'run.cancelled':
      return withEnvelopeVersion(
        {
          ...prev,
          runs: updateRunStatus(prev.runs, envelope.event.runId, {
            type: 'cancelled',
            completedAt: envelope.createdAt,
            reason: envelope.event.reason,
          }),
        },
        envelope,
      )

    case 'run.completed':
      return withEnvelopeVersion(
        {
          ...prev,
          runs: updateRunStatus(prev.runs, envelope.event.runId, {
            type: 'completed',
            completedAt: envelope.createdAt,
            stopReason: envelope.event.stopReason,
          }),
          usage: envelope.event.usage ?? prev.usage,
        },
        envelope,
      )

    case 'run.failed':
      return withEnvelopeVersion(
        {
          ...prev,
          runs: updateRunStatus(prev.runs, envelope.event.runId, {
            type: 'failed',
            completedAt: envelope.createdAt,
            error: envelope.event.error,
          }),
        },
        envelope,
      )

    case 'run.interrupted':
      return withEnvelopeVersion(
        {
          ...prev,
          runs: updateRunStatus(prev.runs, envelope.event.runId, {
            type: 'interrupted',
            completedAt: envelope.createdAt,
            reason: envelope.event.reason,
          }),
        },
        envelope,
      )

    case 'approval.requested':
      return withEnvelopeVersion(
        {
          ...prev,
          pendingApprovals: upsertPendingApproval(
            prev.pendingApprovals,
            envelope.event.approval,
          ),
        },
        envelope,
      )

    case 'approval.resolved':
      return withEnvelopeVersion(
        {
          ...prev,
          pendingApprovals: resolvePendingApproval(
            prev.pendingApprovals,
            envelope.event.approval,
          ),
        },
        envelope,
      )

    case 'usage.updated':
      return withEnvelopeVersion(
        {
          ...prev,
          usage: envelope.event.usage,
        },
        envelope,
      )

    case 'message.started':
    case 'message.delta':
    case 'message.completed':
      return withEnvelopeVersion(
        {
          ...prev,
          messages: [...prev.messages, envelope],
        },
        envelope,
      )

    default:
      return withEnvelopeVersion(prev, envelope)
  }
}

export function buildSessionSnapshot(
  session: SessionRecord,
  events: AppServerEventEnvelope[],
): SessionSnapshot {
  let snapshot: SessionSnapshot = emptySnapshot(session)

  for (const envelope of events) {
    snapshot = reduceSessionSnapshot(snapshot, envelope) ?? snapshot
  }

  if (events.length === 0) {
    return snapshot
  }

  const latestEnvelope = events[events.length - 1]
  return {
    ...snapshot,
    session: withConversation(session, snapshot.session),
    version: latestEnvelope.seq,
    updatedAt: latestEnvelope.createdAt,
  }
}

function withConversation(
  base: SessionRecord,
  source: SessionRecord,
): SessionRecord {
  return {
    ...source,
    ...(base.hasConversation || source.hasConversation
      ? { hasConversation: true }
      : {}),
  }
}

function emptySnapshot(session: SessionRecord): SessionSnapshot {
  return {
    session,
    version: 0,
    updatedAt: session.updatedAt,
    runs: [],
    messages: [],
    pendingApprovals: [],
  }
}

function withEnvelopeVersion(
  snapshot: SessionSnapshot,
  envelope: AppServerEventEnvelope,
): SessionSnapshot {
  return {
    ...snapshot,
    version: envelope.seq,
    updatedAt: envelope.createdAt,
  }
}

function upsertRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const nextRuns = runs.filter(existing => existing.runId !== run.runId)
  nextRuns.push(run)
  return nextRuns
}

function updateRunStatus(
  runs: RunRecord[],
  runId: string,
  status: RunStatus,
): RunRecord[] {
  return runs.map(run => (run.runId === runId ? { ...run, status } : run))
}

function upsertPendingApproval(
  approvals: ApprovalRecord[],
  approval: ApprovalRecord,
): ApprovalRecord[] {
  const nextApprovals = approvals.filter(
    existing => existing.approvalId !== approval.approvalId,
  )
  if (approval.status.type === 'pending') {
    nextApprovals.push(approval)
  }
  return nextApprovals
}

function resolvePendingApproval(
  approvals: ApprovalRecord[],
  approval: ApprovalRecord,
): ApprovalRecord[] {
  if (approval.status.type === 'pending') {
    return upsertPendingApproval(approvals, approval)
  }

  return approvals.filter(
    existing => existing.approvalId !== approval.approvalId,
  )
}
