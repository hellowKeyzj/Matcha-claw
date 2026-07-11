import { describe, expect, test } from 'bun:test'
import type {
  AppServerEvent,
  AppServerEventEnvelope,
} from '../protocol/types.js'
import {
  SessionEventCommitter,
  type SessionEventPostAppendStage,
} from '../sessions/sessionEventCommitter.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

function createMessageDeltaEvent(seq: number): AppServerEvent {
  return {
    type: 'message.delta',
    messageId: `message-${seq}`,
    delta: String(seq),
  }
}

function sequenceForEvent(event: AppServerEvent): number {
  if (event.type !== 'message.delta') {
    throw new Error(`Expected message.delta event, received ${event.type}`)
  }

  return Number(event.delta)
}

function createEnvelope(
  sessionId: string,
  event: AppServerEvent,
): AppServerEventEnvelope {
  const seq = sequenceForEvent(event)
  return {
    eventId: `event-${sessionId}-${seq}`,
    sessionId,
    seq,
    createdAt: '2026-01-01T00:00:00.000Z',
    event,
  }
}

describe('SessionEventCommitter', () => {
  test('serializes the complete event pipeline for one session', async () => {
    const calls: string[] = []
    const metadataEntered = createDeferred<void>()
    const releaseMetadata = createDeferred<void>()
    const committer = new SessionEventCommitter({
      append: async (sessionId, event) => {
        const seq = sequenceForEvent(event)
        calls.push(`append:${seq}`)
        return createEnvelope(sessionId, event)
      },
      updateSessionMetadata: async envelope => {
        calls.push(`metadata:${envelope.seq}`)
        if (envelope.seq === 10) {
          metadataEntered.resolve()
          await releaseMetadata.promise
        }
      },
      updateSnapshot: async envelope => {
        calls.push(`snapshot:${envelope.seq}`)
      },
      publish: envelope => {
        calls.push(`publish:${envelope.seq}`)
      },
      reportPostAppendFailure: () => {},
    })

    const firstCommit = committer.commit('session-1', createMessageDeltaEvent(10))
    await metadataEntered.promise
    const secondCommit = committer.commit(
      'session-1',
      createMessageDeltaEvent(11),
    )

    expect(calls).toEqual(['append:10', 'metadata:10'])
    expect(calls).not.toContain('append:11')

    releaseMetadata.resolve()
    await expect(Promise.all([firstCommit, secondCommit])).resolves.toHaveLength(2)
    expect(calls).toEqual([
      'append:10',
      'metadata:10',
      'snapshot:10',
      'publish:10',
      'append:11',
      'metadata:11',
      'snapshot:11',
      'publish:11',
    ])
  })

  test('allows another session to publish while one session is held', async () => {
    const calls: string[] = []
    const sessionAMetadataEntered = createDeferred<void>()
    const releaseSessionAMetadata = createDeferred<void>()
    const committer = new SessionEventCommitter({
      append: async (sessionId, event) => {
        const seq = sequenceForEvent(event)
        calls.push(`append:${sessionId}:${seq}`)
        return createEnvelope(sessionId, event)
      },
      updateSessionMetadata: async envelope => {
        calls.push(`metadata:${envelope.sessionId}:${envelope.seq}`)
        if (envelope.sessionId === 'session-a') {
          sessionAMetadataEntered.resolve()
          await releaseSessionAMetadata.promise
        }
      },
      updateSnapshot: async envelope => {
        calls.push(`snapshot:${envelope.sessionId}:${envelope.seq}`)
      },
      publish: envelope => {
        calls.push(`publish:${envelope.sessionId}:${envelope.seq}`)
      },
      reportPostAppendFailure: () => {},
    })

    const sessionACommit = committer.commit(
      'session-a',
      createMessageDeltaEvent(10),
    )
    await sessionAMetadataEntered.promise

    await expect(
      committer.commit('session-b', createMessageDeltaEvent(20)),
    ).resolves.toMatchObject({ sessionId: 'session-b', seq: 20 })
    expect(calls).toEqual([
      'append:session-a:10',
      'metadata:session-a:10',
      'append:session-b:20',
      'metadata:session-b:20',
      'snapshot:session-b:20',
      'publish:session-b:20',
    ])

    releaseSessionAMetadata.resolve()
    await expect(sessionACommit).resolves.toMatchObject({
      sessionId: 'session-a',
      seq: 10,
    })
  })

  test('continues post-append work and later commits after metadata fails', async () => {
    const calls: string[] = []
    const reports: Array<{ stage: SessionEventPostAppendStage; seq: number }> = []
    const metadataFailure = new Error('metadata failed')
    const committer = new SessionEventCommitter({
      append: async (sessionId, event) => {
        const seq = sequenceForEvent(event)
        calls.push(`append:${seq}`)
        return createEnvelope(sessionId, event)
      },
      updateSessionMetadata: async envelope => {
        calls.push(`metadata:${envelope.seq}`)
        if (envelope.seq === 10) throw metadataFailure
      },
      updateSnapshot: async envelope => {
        calls.push(`snapshot:${envelope.seq}`)
      },
      publish: envelope => {
        calls.push(`publish:${envelope.seq}`)
      },
      reportPostAppendFailure: (stage, envelope) => {
        reports.push({ stage, seq: envelope.seq })
      },
    })

    await expect(
      Promise.all([
        committer.commit('session-1', createMessageDeltaEvent(10)),
        committer.commit('session-1', createMessageDeltaEvent(11)),
      ]),
    ).resolves.toHaveLength(2)

    expect(reports).toEqual([{ stage: 'sessionMetadata', seq: 10 }])
    expect(calls).toEqual([
      'append:10',
      'metadata:10',
      'snapshot:10',
      'publish:10',
      'append:11',
      'metadata:11',
      'snapshot:11',
      'publish:11',
    ])
  })

  test('publishes and continues after snapshot projection fails', async () => {
    const calls: string[] = []
    const reports: Array<{ stage: SessionEventPostAppendStage; seq: number }> = []
    const committer = new SessionEventCommitter({
      append: async (sessionId, event) => {
        const seq = sequenceForEvent(event)
        calls.push(`append:${seq}`)
        return createEnvelope(sessionId, event)
      },
      updateSessionMetadata: async envelope => {
        calls.push(`metadata:${envelope.seq}`)
      },
      updateSnapshot: async envelope => {
        calls.push(`snapshot:${envelope.seq}`)
        if (envelope.seq === 10) throw new Error('snapshot failed')
      },
      publish: envelope => {
        calls.push(`publish:${envelope.seq}`)
      },
      reportPostAppendFailure: (stage, envelope) => {
        reports.push({ stage, seq: envelope.seq })
      },
    })

    await expect(
      Promise.all([
        committer.commit('session-1', createMessageDeltaEvent(10)),
        committer.commit('session-1', createMessageDeltaEvent(11)),
      ]),
    ).resolves.toHaveLength(2)

    expect(reports).toEqual([{ stage: 'snapshot', seq: 10 }])
    expect(calls).toEqual([
      'append:10',
      'metadata:10',
      'snapshot:10',
      'publish:10',
      'append:11',
      'metadata:11',
      'snapshot:11',
      'publish:11',
    ])
  })

  test('does not publish an append failure and keeps the queue tail usable', async () => {
    const calls: string[] = []
    const reports: Array<{ stage: SessionEventPostAppendStage; seq: number }> = []
    const appendEntered = createDeferred<void>()
    const failAppend = createDeferred<void>()
    const appendFailure = new Error('append failed')
    const committer = new SessionEventCommitter({
      append: async (sessionId, event) => {
        const seq = sequenceForEvent(event)
        calls.push(`append:${seq}`)
        if (seq === 10) {
          appendEntered.resolve()
          await failAppend.promise
          throw appendFailure
        }
        return createEnvelope(sessionId, event)
      },
      updateSessionMetadata: async envelope => {
        calls.push(`metadata:${envelope.seq}`)
      },
      updateSnapshot: async envelope => {
        calls.push(`snapshot:${envelope.seq}`)
      },
      publish: envelope => {
        calls.push(`publish:${envelope.seq}`)
      },
      reportPostAppendFailure: (stage, envelope) => {
        reports.push({ stage, seq: envelope.seq })
      },
    })

    const failedCommit = committer.commit(
      'session-1',
      createMessageDeltaEvent(10),
    )
    await appendEntered.promise
    const laterCommit = committer.commit(
      'session-1',
      createMessageDeltaEvent(11),
    )
    expect(calls).toEqual(['append:10'])

    failAppend.resolve()
    await expect(failedCommit).rejects.toThrow(appendFailure)
    await expect(laterCommit).resolves.toMatchObject({
      sessionId: 'session-1',
      seq: 11,
    })

    expect(reports).toEqual([])
    expect(calls).toEqual([
      'append:10',
      'append:11',
      'metadata:11',
      'snapshot:11',
      'publish:11',
    ])
  })
})
