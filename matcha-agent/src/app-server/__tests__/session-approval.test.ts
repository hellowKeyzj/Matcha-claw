import { basename, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ApprovalBroker } from '../approvals/approvalBroker.js'
import {
  RunCoordinator,
  transitionRunStatus,
} from '../sessions/runCoordinator.js'
import { SessionRegistry } from '../sessions/sessionRegistry.js'
import type {
  ApprovalOption,
  WorkerApprovalRequest,
} from '../protocol/types.js'

function fixedClock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
}

function sequentialIds(prefix: string): () => string {
  let nextId = 0
  return () => `${prefix}-${++nextId}`
}

const approvalOptions: ApprovalOption[] = [
  { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once' },
  { optionId: 'deny-once', label: 'Deny once', kind: 'reject_once' },
]

function approvalRequest(runId: string): WorkerApprovalRequest {
  return {
    runId,
    toolCallId: `tool-${runId}`,
    toolName: 'Bash',
    prompt: 'Run command?',
    input: { command: 'npm test' },
    options: approvalOptions,
  }
}

describe('SessionRegistry', () => {
  test('creates, lists, loads, updates worker state, and closes records using normalized workspace roots', async () => {
    const registry = new SessionRegistry({
      createSessionId: sequentialIds('session'),
      now: fixedClock(),
      resolveWorkspaceRoot: async cwd => `${cwd}/real`,
    })

    const created = await registry.create({
      cwd: '.',
      title: 'Local workspace',
      model: 'sonnet',
      permissionMode: 'default',
    })

    expect(created.resultType).toBe('created')
    if (created.resultType !== 'created') return
    expect(created.session).toMatchObject({
      sessionId: 'session-1',
      runtime: 'matcha-agent',
      title: 'Local workspace',
      model: 'sonnet',
      permissionMode: 'default',
      lastSeq: 0,
      lastSnapshotVersion: 0,
      workerState: { state: 'unloaded', reason: 'notStarted' },
    })
    expect(basename(created.session.workspaceRoot)).toBe('real')

    const loaded = registry.load('session-1')
    expect(loaded).toEqual({ resultType: 'loaded', session: created.session })

    const updated = registry.updateWorkerState('session-1', {
      state: 'ready',
      workerId: 'worker-1',
      pid: 42,
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    })
    expect(updated.resultType).toBe('updated')
    if (updated.resultType !== 'updated') return
    expect(updated.session.workerState).toEqual({
      state: 'ready',
      workerId: 'worker-1',
      pid: 42,
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    })

    expect(registry.list()).toEqual([updated.session])
    expect(registry.close('session-1')).toEqual({
      resultType: 'closed',
      session: updated.session,
    })
    expect(registry.load('session-1')).toEqual({
      resultType: 'sessionNotFound',
      sessionId: 'session-1',
    })
  })

  test.each([
    ['git metadata directory', ['workspace', '.git']],
    ['claude config directory', ['workspace', '.claude']],
    ['credential file', ['workspace', 'credentials']],
    ['shell profile file', ['workspace', '.bashrc']],
  ])('rejects %s as a workspace root', async (_label, pathSegments) => {
    const registry = new SessionRegistry({
      createSessionId: sequentialIds('session'),
      now: fixedClock(),
      resolveWorkspaceRoot: async () => resolve(...pathSegments),
    })

    const created = await registry.create({ cwd: 'workspace' })

    expect(created).toMatchObject({
      resultType: 'workspaceUnavailable',
      cwd: 'workspace',
      resolvedPath: resolve(...pathSegments),
      message: expect.stringContaining(
        'Sensitive workspace path is not allowed',
      ),
    })
    expect(registry.list()).toEqual([])
  })

  test('allows ordinary workspace roots', async () => {
    const registry = new SessionRegistry({
      createSessionId: sequentialIds('session'),
      now: fixedClock(),
      resolveWorkspaceRoot: async () => resolve('workspace', 'project'),
    })

    const created = await registry.create({ cwd: 'workspace' })

    expect(created.resultType).toBe('created')
    if (created.resultType !== 'created') return
    expect(created.session.workspaceRoot).toBe(resolve('workspace', 'project'))
  })
})

describe('RunCoordinator', () => {
  test('serializes prompts for the same session', () => {
    const coordinator = new RunCoordinator({
      maxQueueSize: 2,
      createRunId: sequentialIds('run'),
      createPromptId: sequentialIds('prompt'),
      now: fixedClock(),
    })

    const first = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'first',
    })
    const second = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'second',
    })

    expect(first.resultType).toBe('enqueued')
    expect(second.resultType).toBe('enqueued')
    if (first.resultType !== 'enqueued' || second.resultType !== 'enqueued')
      return

    const startedFirst = coordinator.startNext('session-1', 'worker-1')
    expect(startedFirst.resultType).toBe('started')
    if (startedFirst.resultType !== 'started') return
    expect(startedFirst.queuedRun).toMatchObject({
      prompt: 'first',
      run: {
        runId: 'run-1',
        promptId: 'prompt-1',
        status: { type: 'running', workerId: 'worker-1' },
      },
    })

    const blockedSecond = coordinator.startNext('session-1', 'worker-1')
    expect(blockedSecond.resultType).toBe('sessionAlreadyRunning')
    expect(coordinator.getRun('run-2')?.status).toEqual(
      second.queuedRun.run.status,
    )

    const completedFirst = coordinator.complete('run-1', 'end_turn')
    expect(completedFirst.resultType).toBe('updated')
    if (completedFirst.resultType !== 'updated') return
    expect(completedFirst.run.status.type).toBe('completed')

    const startedSecond = coordinator.startNext('session-1', 'worker-1')
    expect(startedSecond.resultType).toBe('started')
    if (startedSecond.resultType !== 'started') return
    expect(startedSecond.queuedRun).toMatchObject({
      prompt: 'second',
      run: {
        runId: 'run-2',
        promptId: 'prompt-2',
        status: { type: 'running', workerId: 'worker-1' },
      },
    })
  })

  test('fails a queued run when worker startup fails before the run starts', () => {
    const coordinator = new RunCoordinator({
      maxQueueSize: 1,
      createRunId: sequentialIds('run'),
      createPromptId: sequentialIds('prompt'),
      now: fixedClock(),
    })
    const enqueued = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'first',
    })
    expect(enqueued.resultType).toBe('enqueued')
    if (enqueued.resultType !== 'enqueued') return

    const failed = coordinator.failStart(enqueued.queuedRun.run.runId, {
      type: 'worker',
      message: 'worker initialize failed',
      retryable: true,
    })

    expect(failed.resultType).toBe('updated')
    if (failed.resultType !== 'updated') return
    expect(failed.run.status).toMatchObject({
      type: 'failed',
      error: {
        type: 'worker',
        message: 'worker initialize failed',
        retryable: true,
      },
    })
  })

  test('does not use the worker-owned fail transition before the run starts', () => {
    expect(
      transitionRunStatus(
        { type: 'queued', queuedAt: '2026-01-01T00:00:00.000Z' },
        {
          type: 'fail',
          completedAt: '2026-01-01T00:00:01.000Z',
          error: { type: 'worker', message: 'failed', retryable: true },
        },
      ),
    ).toMatchObject({ resultType: 'invalidTransition' })
  })

  test('preserves caller-provided runId when enqueueing a prompt', () => {
    const coordinator = new RunCoordinator({
      maxQueueSize: 1,
      createRunId: sequentialIds('run'),
      createPromptId: sequentialIds('prompt'),
      now: fixedClock(),
    })

    const result = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'first',
      runId: 'runtime-host-run-1',
    })

    expect(result.resultType).toBe('enqueued')
    if (result.resultType !== 'enqueued') return
    expect(result.queuedRun.run).toMatchObject({
      runId: 'runtime-host-run-1',
      promptId: 'prompt-1',
    })
  })

  test('returns duplicateRun for a duplicate caller-provided runId without replacing the queued run', () => {
    const coordinator = new RunCoordinator({
      maxQueueSize: 1,
      createRunId: sequentialIds('run'),
      createPromptId: sequentialIds('prompt'),
      now: fixedClock(),
    })

    const first = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'first',
      runId: 'runtime-host-run-1',
    })
    const duplicate = coordinator.enqueue({
      sessionId: 'session-1',
      prompt: 'duplicate',
      runId: 'runtime-host-run-1',
    })

    expect(first.resultType).toBe('enqueued')
    if (first.resultType !== 'enqueued') return
    expect(duplicate).toEqual({
      resultType: 'duplicateRun',
      runId: 'runtime-host-run-1',
    })
    expect(coordinator.getRun('runtime-host-run-1')).toEqual(
      first.queuedRun.run,
    )

    const started = coordinator.startNext('session-1', 'worker-1')
    expect(started.resultType).toBe('started')
    if (started.resultType !== 'started') return
    expect(started.queuedRun.prompt).toBe('first')
    expect(started.queuedRun.run.runId).toBe('runtime-host-run-1')
  })

  test('returns a structured error when the session prompt queue is full', () => {
    const coordinator = new RunCoordinator({
      maxQueueSize: 1,
      createRunId: sequentialIds('run'),
      createPromptId: sequentialIds('prompt'),
      now: fixedClock(),
    })

    expect(
      coordinator.enqueue({ sessionId: 'session-1', prompt: 'first' })
        .resultType,
    ).toBe('enqueued')
    expect(
      coordinator.enqueue({ sessionId: 'session-1', prompt: 'second' }),
    ).toEqual({
      resultType: 'queueFull',
      sessionId: 'session-1',
      maxQueueSize: 1,
      queuedCount: 1,
    })
  })

  test('exports pure run status transitions', () => {
    const result = transitionRunStatus(
      { type: 'queued', queuedAt: '2026-01-01T00:00:00.000Z' },
      {
        type: 'start',
        workerId: 'worker-1',
        startedAt: '2026-01-01T00:00:01.000Z',
      },
    )

    expect(result).toEqual({
      resultType: 'transitioned',
      status: {
        type: 'running',
        workerId: 'worker-1',
        startedAt: '2026-01-01T00:00:01.000Z',
      },
    })
  })
})

describe('ApprovalBroker', () => {
  test('approves pending approvals and returns the same terminal decision on duplicate respond', () => {
    const broker = new ApprovalBroker({
      createApprovalId: sequentialIds('approval'),
      now: fixedClock(),
    })

    const created = broker.create({
      sessionId: 'session-1',
      workerId: 'worker-1',
      request: approvalRequest('run-1'),
    })

    expect(created.approval.status.type).toBe('pending')
    const approved = broker.respond({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      optionId: 'allow-once',
    })

    expect(approved.resultType).toBe('responded')
    if (approved.resultType !== 'responded') return
    expect(approved.decision).toEqual({
      type: 'approved',
      optionId: 'allow-once',
    })
    expect(approved.approval.status).toMatchObject({
      type: 'approved',
      optionId: 'allow-once',
    })
    expect(broker.listPending('session-1')).toEqual([])

    const duplicate = broker.respond({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      optionId: 'deny-once',
      reason: 'changed my mind',
    })

    expect(duplicate.resultType).toBe('alreadyResolved')
    if (duplicate.resultType !== 'alreadyResolved') return
    expect(duplicate.status).toMatchObject({
      type: 'approved',
      optionId: 'allow-once',
    })
    expect(duplicate.decision).toEqual(approved.decision)
  })

  test('denies pending approvals with the selected reject option', () => {
    const broker = new ApprovalBroker({
      createApprovalId: sequentialIds('approval'),
      now: fixedClock(),
    })
    broker.create({
      sessionId: 'session-1',
      workerId: 'worker-1',
      request: approvalRequest('run-1'),
    })

    const denied = broker.respond({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      optionId: 'deny-once',
      reason: 'too risky',
    })

    expect(denied.resultType).toBe('responded')
    if (denied.resultType !== 'responded') return
    expect(denied.decision).toEqual({
      type: 'denied',
      optionId: 'deny-once',
      reason: 'too risky',
    })
    expect(denied.approval.status).toMatchObject({
      type: 'denied',
      reason: 'too risky',
    })
  })

  test('cancels pending approvals by run and by worker without FIFO assumptions', () => {
    const broker = new ApprovalBroker({
      createApprovalId: sequentialIds('approval'),
      now: fixedClock(),
    })
    broker.create({
      sessionId: 'session-1',
      workerId: 'worker-1',
      request: approvalRequest('run-1'),
    })
    broker.create({
      sessionId: 'session-1',
      workerId: 'worker-2',
      request: approvalRequest('run-2'),
    })
    broker.create({
      sessionId: 'session-2',
      workerId: 'worker-2',
      request: approvalRequest('run-3'),
    })

    const cancelledByRun = broker.cancelByRun('run-2')
    expect(cancelledByRun.map(item => item.approval.approvalId)).toEqual([
      'approval-2',
    ])
    expect(cancelledByRun[0]?.decision).toEqual({
      type: 'cancelled',
      reason: 'runCancelled',
    })

    const cancelledByWorker = broker.cancelByWorker('worker-2')
    expect(cancelledByWorker.map(item => item.approval.approvalId)).toEqual([
      'approval-3',
    ])
    expect(cancelledByWorker[0]?.decision).toEqual({
      type: 'cancelled',
      reason: 'workerExited',
    })

    expect(broker.listPending().map(approval => approval.approvalId)).toEqual([
      'approval-1',
    ])
  })
})
