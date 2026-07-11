import { describe, expect, test } from 'bun:test'
import type {
  AppServerEventEnvelope,
  RunRecord,
  SessionRecord,
} from '../protocol/types.js'
import { buildSessionSnapshot } from '../stores/sessionSnapshotReducer.js'

const session: SessionRecord = {
  sessionId: 'session-1',
  workspaceRoot: '/workspace',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
  runtime: 'matcha-agent',
  lastSeq: 0,
  lastSnapshotVersion: 0,
  workerState: { state: 'unloaded', reason: 'notStarted' },
}

const run: RunRecord = {
  runId: 'run-1',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  status: { type: 'queued', queuedAt: '2026-07-09T00:00:01.000Z' },
}

describe('sessionSnapshotReducer', () => {
  test('stores run.trace in messages without changing run lifecycle status', () => {
    const traceEnvelope = envelope(4, {
      runId: 'run-1',
      workerId: 'worker-1',
      event: {
        type: 'run.trace',
        runId: 'run-1',
        workerId: 'worker-1',
        stage: 'api.stream.first_chunk',
        details: { requestId: 'req-1' },
      },
    })

    const snapshot = buildSessionSnapshot(session, [
      envelope(1, { event: { type: 'session.created', session } }),
      envelope(2, { runId: 'run-1', event: { type: 'run.queued', run } }),
      envelope(3, {
        runId: 'run-1',
        workerId: 'worker-1',
        event: { type: 'run.started', runId: 'run-1', workerId: 'worker-1' },
      }),
      traceEnvelope,
    ])

    expect(snapshot.messages).toEqual([traceEnvelope])
    expect(snapshot.session.hasConversation).toBe(true)
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: expect.objectContaining({ type: 'running' }),
      }),
    )
  })
})

function envelope(
  seq: number,
  overrides: Pick<AppServerEventEnvelope, 'event'> &
    Partial<Omit<AppServerEventEnvelope, 'event'>>,
): AppServerEventEnvelope {
  return {
    eventId: `event-${seq}`,
    sessionId: 'session-1',
    seq,
    createdAt: `2026-07-09T00:00:0${seq}.000Z`,
    ...overrides,
  }
}
