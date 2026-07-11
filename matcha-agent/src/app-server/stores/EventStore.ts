import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppServerEvent,
  AppServerEventEnvelope,
} from '../protocol/types.js'
import { sessionStorageDirectoryName } from './sessionStoragePath.js'

export class EventStore {
  private readonly storageRoot: string
  private readonly appendQueues = new Map<string, Promise<void>>()
  // Append owns seq allocation in-process; replay still reads the event log.
  private readonly latestSeqBySession = new Map<string, number>()

  constructor(options: { storageRoot: string }) {
    this.storageRoot = options.storageRoot
  }

  append(
    sessionId: string,
    event: AppServerEvent,
    fields: {
      runId?: string
      workerId?: string
      eventId?: string
      createdAt?: string
    } = {},
  ): Promise<AppServerEventEnvelope> {
    const envelopeFields = { ...fields }
    const previousAppend = this.appendQueues.get(sessionId) ?? Promise.resolve()
    const appendOperation = previousAppend.then(() =>
      this.appendAfterPrevious(sessionId, event, envelopeFields),
    )
    const queueTail = appendOperation.then(
      () => undefined,
      () => undefined,
    )

    this.appendQueues.set(sessionId, queueTail)
    void queueTail.finally(() => {
      if (this.appendQueues.get(sessionId) === queueTail) {
        this.appendQueues.delete(sessionId)
      }
    })

    return appendOperation
  }

  async replay(
    sessionId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<AppServerEventEnvelope[]> {
    const envelopes = await this.readEnvelopes(sessionId)
    const afterSeq = options.afterSeq ?? 0
    const limit =
      options.limit !== undefined && options.limit >= 0
        ? options.limit
        : undefined
    const replayed: AppServerEventEnvelope[] = []

    for (const envelope of envelopes) {
      if (envelope.seq <= afterSeq) continue
      if (limit !== undefined && replayed.length >= limit) break
      replayed.push(envelope)
    }

    return replayed
  }

  private async appendAfterPrevious(
    sessionId: string,
    event: AppServerEvent,
    fields: {
      runId?: string
      workerId?: string
      eventId?: string
      createdAt?: string
    },
  ): Promise<AppServerEventEnvelope> {
    const filePath = this.eventsPath(sessionId)
    const latestSeq = await this.getLatestSeq(sessionId)
    const seq = latestSeq + 1
    const envelope: AppServerEventEnvelope = {
      eventId: fields.eventId ?? randomUUID(),
      sessionId,
      seq,
      ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
      ...(fields.workerId !== undefined ? { workerId: fields.workerId } : {}),
      createdAt: fields.createdAt ?? new Date().toISOString(),
      event,
    }

    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, `${JSON.stringify(envelope)}\n`, 'utf8')
    this.latestSeqBySession.set(sessionId, seq)
    return envelope
  }

  private async getLatestSeq(sessionId: string): Promise<number> {
    const cachedLatestSeq = this.latestSeqBySession.get(sessionId)
    if (cachedLatestSeq !== undefined) return cachedLatestSeq

    const latestSeq = await this.readLatestSeq(sessionId)
    this.latestSeqBySession.set(sessionId, latestSeq)
    return latestSeq
  }

  private async readLatestSeq(sessionId: string): Promise<number> {
    const envelopes = await this.readEnvelopes(sessionId)
    let latestSeq = 0
    for (const envelope of envelopes) {
      if (envelope.seq > latestSeq) latestSeq = envelope.seq
    }
    return latestSeq
  }

  private async readEnvelopes(
    sessionId: string,
  ): Promise<AppServerEventEnvelope[]> {
    const filePath = this.eventsPath(sessionId)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return []
      throw error
    }

    const envelopes: AppServerEventEnvelope[] = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const parsed: unknown = JSON.parse(trimmed)
      if (!isEventEnvelope(parsed)) {
        throw new Error(`Invalid app-server event envelope in ${filePath}`)
      }
      envelopes.push(parsed)
    }

    return envelopes
  }

  private eventsPath(sessionId: string): string {
    return join(
      this.storageRoot,
      'sessions',
      sessionStorageDirectoryName(sessionId),
      'events.jsonl',
    )
  }
}

function isEventEnvelope(value: unknown): value is AppServerEventEnvelope {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.seq === 'number' &&
    Number.isFinite(value.seq) &&
    (!('runId' in value) || typeof value.runId === 'string') &&
    (!('workerId' in value) || typeof value.workerId === 'string') &&
    typeof value.createdAt === 'string' &&
    isRecord(value.event)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
