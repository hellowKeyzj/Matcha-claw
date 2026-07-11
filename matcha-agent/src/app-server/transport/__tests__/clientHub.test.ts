import { describe, expect, test } from 'bun:test'
import { ClientHub } from '../clientHub.js'
import { encodeJsonRpcMessage } from '../../protocol/jsonRpc.js'
import type { AppServerEventEnvelope } from '../../protocol/types.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type ClientClosedResult = {
  resultType: 'clientClosed'
  clientId: string
  reason: 'queueOverflow'
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function resolveWithin<T>(
  value: T | Promise<T>,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          250,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function eventEnvelope(sessionId: string, seq: number): AppServerEventEnvelope {
  return {
    eventId: `${sessionId}-${seq}`,
    sessionId,
    seq,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    event: {
      type: 'message.delta',
      messageId: `message-${seq}`,
      delta: `delta-${seq}`,
    },
  }
}

function expectEncodedEventPayload(
  payload: string,
  envelope: AppServerEventEnvelope,
): void {
  expect(payload).toBe(
    encodeJsonRpcMessage({ jsonrpc: '2.0', method: 'event', params: envelope }),
  )
}

function eventIdFromPayload(payload: string): string {
  const parsed: unknown = JSON.parse(payload)
  if (
    !isRecord(parsed) ||
    parsed.method !== 'event' ||
    !isEventEnvelope(parsed.params)
  ) {
    throw new Error('Expected an event JSON-RPC notification payload')
  }
  return parsed.params.eventId
}

function isClientClosedResult(value: unknown): value is ClientClosedResult {
  return (
    isRecord(value) &&
    value.resultType === 'clientClosed' &&
    typeof value.clientId === 'string' &&
    value.reason === 'queueOverflow'
  )
}

function isEventEnvelope(value: unknown): value is AppServerEventEnvelope {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.createdAt === 'string' &&
    isRecord(value.event) &&
    typeof value.event.type === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('ClientHub', () => {
  test('broadcasts only matching subscription events after the subscribed sequence', async () => {
    const sessionPayloads: string[] = []
    const otherSessionPayloads: string[] = []
    const hub = new ClientHub({ maxClientQueueSize: 8 })

    const sessionClientId = hub.registerClient(payload => {
      sessionPayloads.push(payload)
    }, 'session-client')
    const otherSessionClientId = hub.registerClient(payload => {
      otherSessionPayloads.push(payload)
    }, 'other-session-client')

    hub.subscribe(sessionClientId, 'session-1', 5)
    hub.subscribe(otherSessionClientId, 'session-2')

    const skippedBySeq = eventEnvelope('session-1', 5)
    const deliveredToOtherSession = eventEnvelope('session-2', 1)
    const deliveredToSession = eventEnvelope('session-1', 6)

    await hub.broadcast(skippedBySeq)
    await hub.broadcast(deliveredToOtherSession)
    await hub.broadcast(deliveredToSession)

    expect(sessionPayloads).toHaveLength(1)
    expect(otherSessionPayloads).toHaveLength(1)
    expectEncodedEventPayload(sessionPayloads[0] ?? '', deliveredToSession)
    expectEncodedEventPayload(
      otherSessionPayloads[0] ?? '',
      deliveredToOtherSession,
    )
  })

  test('does not suppress a delayed lower sequence after a higher live sequence', async () => {
    const payloads: string[] = []
    const hub = new ClientHub({ maxClientQueueSize: 8 })
    const clientId = hub.registerClient(payload => {
      payloads.push(payload)
    }, 'out-of-order-client')

    hub.subscribe(clientId, 'session-1', 9)
    const higherSequence = eventEnvelope('session-1', 11)
    const delayedSequence = eventEnvelope('session-1', 10)
    const laterSequence = eventEnvelope('session-1', 12)

    hub.broadcast(higherSequence)
    hub.broadcast(delayedSequence)
    hub.broadcast(laterSequence)

    await waitFor(() => payloads.length === 3, 'out-of-order live events')

    expectEncodedEventPayload(payloads[0] ?? '', higherSequence)
    expectEncodedEventPayload(payloads[1] ?? '', delayedSequence)
    expectEncodedEventPayload(payloads[2] ?? '', laterSequence)
  })

  test('preserves event order for a client with asynchronous sends', async () => {
    const firstSendReleased = deferred()
    const startedEventIds: string[] = []
    const completedEventIds: string[] = []
    const hub = new ClientHub({ maxClientQueueSize: 4 })

    const clientId = hub.registerClient(async payload => {
      const eventId = eventIdFromPayload(payload)
      startedEventIds.push(eventId)
      if (eventId === 'ordered-session-1') {
        await firstSendReleased.promise
      }
      completedEventIds.push(eventId)
    }, 'ordered-client')
    hub.subscribe(clientId, 'ordered-session')

    const firstBroadcast = Promise.resolve(
      hub.broadcast(eventEnvelope('ordered-session', 1)),
    )
    const secondBroadcast = Promise.resolve(
      hub.broadcast(eventEnvelope('ordered-session', 2)),
    )

    await waitFor(
      () => startedEventIds.length === 1,
      'first async send to start',
    )
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(startedEventIds).toEqual(['ordered-session-1'])
    expect(completedEventIds).toEqual([])

    firstSendReleased.resolve()
    await resolveWithin(
      Promise.all([firstBroadcast, secondBroadcast]),
      'ordered broadcasts',
    )
    await waitFor(
      () => completedEventIds.length === 2,
      'ordered sends to complete',
    )

    expect(startedEventIds).toEqual(['ordered-session-1', 'ordered-session-2'])
    expect(completedEventIds).toEqual([
      'ordered-session-1',
      'ordered-session-2',
    ])
  })

  test('closes clients by queued byte budget', async () => {
    const closedClients: Array<{ clientId: string; reason?: string }> = []
    const firstSendReleased = deferred()
    const startedPayloads: string[] = []
    const hub = new ClientHub({
      maxClientQueueSize: 16,
      maxClientQueuedBytes: 512,
      closeClient: (clientId, reason) => {
        closedClients.push({ clientId, reason })
      },
    })
    const clientId = hub.registerClient(async payload => {
      startedPayloads.push(payload)
      if (startedPayloads.length === 1) {
        await firstSendReleased.promise
      }
    }, 'byte-budget-client')
    hub.subscribe(clientId, 'byte-session')

    hub.broadcast(eventEnvelope('byte-session', 1))
    await waitFor(
      () => startedPayloads.length === 1,
      'first byte budget send to start',
    )
    const largeEnvelope = eventEnvelope('byte-session', 2)
    largeEnvelope.event = {
      type: 'message.delta',
      messageId: 'message-2',
      delta: 'x'.repeat(1024),
    }
    const overflowResult = hub.broadcast(largeEnvelope)

    expect(overflowResult).toEqual({
      resultType: 'clientClosed',
      clientId,
      reason: 'queueOverflow',
    })
    expect(closedClients).toEqual([{ clientId, reason: 'queueOverflow' }])
    firstSendReleased.resolve()
  })

  test('closes a slow client instead of reporting success after queue overflow', async () => {
    const firstSendReleased = deferred()
    const startedEventIds: string[] = []
    const closedClients: Array<{ clientId: string; reason?: string }> = []
    const hub = new ClientHub({
      maxClientQueueSize: 1,
      closeClient: (clientId, reason) => {
        closedClients.push({ clientId, reason })
      },
    })

    const clientId = hub.registerClient(async payload => {
      startedEventIds.push(eventIdFromPayload(payload))
      if (startedEventIds.length === 1) {
        await firstSendReleased.promise
      }
    }, 'slow-client')
    hub.subscribe(clientId, 'overflow-session')

    const firstBroadcast = Promise.resolve(
      hub.broadcast(eventEnvelope('overflow-session', 1)),
    )
    await waitFor(
      () => startedEventIds.length === 1,
      'slow client send to start',
    )

    const secondResult: unknown = await resolveWithin(
      hub.broadcast(eventEnvelope('overflow-session', 2)),
      'second queued broadcast',
    )
    const overflowResult: unknown = isClientClosedResult(secondResult)
      ? secondResult
      : await resolveWithin(
          hub.broadcast(eventEnvelope('overflow-session', 3)),
          'overflow broadcast',
        )

    const closeWasReported =
      isClientClosedResult(overflowResult) ||
      closedClients.some(closedClient => {
        return (
          closedClient.clientId === clientId &&
          closedClient.reason === 'queueOverflow'
        )
      })

    expect(closeWasReported).toBe(true)
    if (isClientClosedResult(overflowResult)) {
      expect(overflowResult).toEqual({
        resultType: 'clientClosed',
        clientId,
        reason: 'queueOverflow',
      })
    }

    const sendCountAfterOverflow = startedEventIds.length
    await resolveWithin(
      hub.broadcast(eventEnvelope('overflow-session', 4)),
      'post-overflow broadcast',
    )
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(startedEventIds).toHaveLength(sendCountAfterOverflow)

    firstSendReleased.resolve()
    await resolveWithin(
      Promise.allSettled([firstBroadcast]),
      'overflow cleanup',
    )
  })
})
