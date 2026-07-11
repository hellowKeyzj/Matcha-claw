import { randomUUID } from 'node:crypto'

import { encodeJsonRpcMessage } from '../protocol/jsonRpc.js'
import type {
  AppServerEventEnvelope,
  JsonRpcNotification,
} from '../protocol/types.js'

export type ClientHubSend = (payload: string) => void | Promise<void>

export type ClientHubCloseReason =
  | 'clientClosed'
  | 'clientReplaced'
  | 'queueOverflow'
  | 'sendFailed'

export type ClientHubCloseClient = (
  clientId: string,
  reason: ClientHubCloseReason,
) => void | Promise<void>

export type ClientHubOptions = {
  maxClientQueueSize: number
  maxClientQueuedBytes?: number
  closeClient?: ClientHubCloseClient
}

export type ClientHubSubscribeResult =
  | {
      resultType: 'subscribed'
      clientId: string
      sessionId: string
      afterSeq?: number
    }
  | { resultType: 'clientNotFound'; clientId: string }

export type ClientHubBroadcastResult =
  | { resultType: 'queued' }
  | { resultType: 'clientClosed'; clientId: string; reason: 'queueOverflow' }

export type ClientHubCloseResult =
  | { resultType: 'closed'; clientId: string; reason: ClientHubCloseReason }
  | { resultType: 'clientNotFound'; clientId: string }

type ClientSubscription = {
  sessionId: string
  afterSeq?: number
}

type ClientConnection = {
  clientId: string
  send: ClientHubSend
  queuedPayloads: string[]
  queueReadIndex: number
  queuedBytes: number
  isSending: boolean
  isClosed: boolean
  subscription?: ClientSubscription
}

export function encodeAppServerEventNotification(
  envelope: AppServerEventEnvelope,
): string {
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: 'event',
    params: envelope,
  }

  return encodeJsonRpcMessage(notification)
}

export class ClientHub {
  private readonly clients = new Map<string, ClientConnection>()
  private readonly maxClientQueueSize: number
  private readonly maxClientQueuedBytes: number
  private readonly closeClient?: ClientHubCloseClient

  constructor(options: ClientHubOptions) {
    this.maxClientQueueSize = options.maxClientQueueSize
    this.maxClientQueuedBytes =
      options.maxClientQueuedBytes ?? options.maxClientQueueSize * 1024 * 1024
    this.closeClient = options.closeClient
  }

  registerClient(send: ClientHubSend, clientId: string = randomUUID()): string {
    if (this.clients.has(clientId)) {
      this.close(clientId, 'clientReplaced')
    }

    this.clients.set(clientId, {
      clientId,
      send,
      queuedPayloads: [],
      queueReadIndex: 0,
      queuedBytes: 0,
      isSending: false,
      isClosed: false,
    })

    return clientId
  }

  subscribe(
    clientId: string,
    sessionId: string,
    afterSeq?: number,
  ): ClientHubSubscribeResult {
    const client = this.clients.get(clientId)
    if (client === undefined) {
      return { resultType: 'clientNotFound', clientId }
    }

    client.subscription = createClientSubscription(sessionId, afterSeq)
    if (afterSeq === undefined) {
      return { resultType: 'subscribed', clientId, sessionId }
    }

    return { resultType: 'subscribed', clientId, sessionId, afterSeq }
  }

  broadcast(envelope: AppServerEventEnvelope): ClientHubBroadcastResult {
    let encodedPayload: string | undefined
    let firstClosedClient: ClientHubBroadcastResult | undefined

    for (const client of this.clients.values()) {
      if (!shouldReceiveEvent(client.subscription, envelope)) {
        continue
      }

      encodedPayload ??= encodeAppServerEventNotification(envelope)
      const enqueueResult = this.enqueueClientPayload(client, encodedPayload)
      if (enqueueResult.resultType === 'queued') {
        continue
      }

      firstClosedClient ??= enqueueResult
    }

    return firstClosedClient ?? { resultType: 'queued' }
  }

  close(
    clientId: string,
    reason: ClientHubCloseReason = 'clientClosed',
  ): ClientHubCloseResult {
    const client = this.clients.get(clientId)
    if (client === undefined) {
      return { resultType: 'clientNotFound', clientId }
    }

    client.isClosed = true
    client.queuedPayloads.length = 0
    client.queueReadIndex = 0
    client.queuedBytes = 0
    delete client.subscription
    this.clients.delete(clientId)
    this.notifyClientClosed(clientId, reason)

    return { resultType: 'closed', clientId, reason }
  }

  private enqueueClientPayload(
    client: ClientConnection,
    payload: string,
  ): ClientHubBroadcastResult {
    client.queuedPayloads.push(payload)
    client.queuedBytes += byteLength(payload)

    const queuedCount = client.queuedPayloads.length - client.queueReadIndex
    if (
      queuedCount > this.maxClientQueueSize ||
      client.queuedBytes > this.maxClientQueuedBytes
    ) {
      this.close(client.clientId, 'queueOverflow')
      return {
        resultType: 'clientClosed',
        clientId: client.clientId,
        reason: 'queueOverflow',
      }
    }

    void this.flushClientQueue(client)
    return { resultType: 'queued' }
  }

  private async flushClientQueue(client: ClientConnection): Promise<void> {
    if (client.isSending) {
      return
    }

    client.isSending = true

    try {
      while (
        !client.isClosed &&
        client.queueReadIndex < client.queuedPayloads.length
      ) {
        const payload = client.queuedPayloads[client.queueReadIndex]
        client.queueReadIndex += 1
        if (payload === undefined) {
          continue
        }
        client.queuedBytes -= byteLength(payload)

        const sendResult = client.send(payload)
        if (isPromiseLike(sendResult)) {
          await sendResult
        }

        compactClientQueue(client)
      }
      compactClientQueue(client)
    } catch {
      this.close(client.clientId, 'sendFailed')
    } finally {
      client.isSending = false
    }
  }

  private notifyClientClosed(
    clientId: string,
    reason: ClientHubCloseReason,
  ): void {
    if (this.closeClient === undefined) {
      return
    }

    try {
      const closeResult = this.closeClient(clientId, reason)
      if (isPromiseLike(closeResult)) {
        void closeResult.catch(() => undefined)
      }
    } catch {
      // Client close notification is best-effort after the hub has already cleaned up.
    }
  }
}

function createClientSubscription(
  sessionId: string,
  afterSeq?: number,
): ClientSubscription {
  if (afterSeq === undefined) {
    return { sessionId }
  }

  return { sessionId, afterSeq }
}

function shouldReceiveEvent(
  subscription: ClientSubscription | undefined,
  envelope: AppServerEventEnvelope,
): boolean {
  if (subscription === undefined) {
    return false
  }

  if (subscription.sessionId !== envelope.sessionId) {
    return false
  }

  return (
    subscription.afterSeq === undefined || envelope.seq > subscription.afterSeq
  )
}

function compactClientQueue(client: ClientConnection): void {
  if (client.queueReadIndex === 0) return

  if (client.queueReadIndex >= client.queuedPayloads.length) {
    client.queuedPayloads.length = 0
    client.queueReadIndex = 0
    return
  }

  if (client.queueReadIndex < 64) return
  client.queuedPayloads.splice(0, client.queueReadIndex)
  client.queueReadIndex = 0
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.then === 'function'
  )
}
