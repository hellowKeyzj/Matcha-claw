import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AppServerEvent,
  SessionRecord,
  SessionSnapshot,
} from '../protocol/types.js'
import {
  BlobStore,
  EventStore,
  SessionIndex,
  SnapshotStore,
} from '../stores/index.js'
import { sessionStorageDirectoryName } from '../stores/sessionStoragePath.js'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matcha-app-server-stores-'))
  tempRoots.push(root)
  return root
}

describe('SessionIndex', () => {
  test('serializes concurrent upserts without dropping sessions', async () => {
    const storageRoot = await createTempRoot()
    const index = new SessionIndex({ storageRoot })

    await Promise.all([
      index.upsert(createSessionRecord('session-1')),
      index.upsert(createSessionRecord('session-2')),
      index.upsert(createSessionRecord('session-3')),
    ])

    expect(await readSessionIds(index)).toEqual([
      'session-1',
      'session-2',
      'session-3',
    ])
  })

  test('applies remove and upsert with queued serial semantics', async () => {
    const storageRoot = await createTempRoot()
    const index = new SessionIndex({ storageRoot })

    const removeSession = index.remove('session-1')
    const upsertSession = index.upsert(createSessionRecord('session-1'))
    await Promise.all([removeSession, upsertSession])

    expect(await readSessionIds(index)).toEqual(['session-1'])
  })

  test('keeps missing and corrupt index fallback as empty list', async () => {
    const storageRoot = await createTempRoot()
    const index = new SessionIndex({ storageRoot })

    expect(await index.readAll()).toEqual([])

    const indexPath = indexFilePath(storageRoot)
    await mkdir(dirname(indexPath), { recursive: true })
    await writeFile(indexPath, '{bad json', 'utf8')
    expect(await index.readAll()).toEqual([])
  })
})

describe('SnapshotStore', () => {
  test('uses a filesystem-safe directory while preserving the session id', async () => {
    const storageRoot = await createTempRoot()
    const store = new SnapshotStore({ storageRoot })
    const sessionId = 'matcha-agent:default:session-1'
    const snapshot = createSessionSnapshot(sessionId, 1)

    await store.writeLatest(sessionId, snapshot)

    expect(await store.readLatest(sessionId)).toEqual(snapshot)
    await expect(
      stat(snapshotFilePath(storageRoot, sessionId)),
    ).resolves.toBeDefined()
  })

  test('does not let an older snapshot overwrite a newer latest snapshot', async () => {
    const storageRoot = await createTempRoot()
    const store = new SnapshotStore({ storageRoot })
    const newerSnapshot = createSessionSnapshot('session-1', 2)
    const olderSnapshot = createSessionSnapshot('session-1', 1)

    await Promise.all([
      store.writeLatest('session-1', newerSnapshot),
      store.writeLatest('session-1', olderSnapshot),
    ])

    expect(await store.readLatest('session-1')).toEqual(newerSnapshot)
  })

  test('keeps missing and corrupt snapshot fallback as undefined', async () => {
    const storageRoot = await createTempRoot()
    const store = new SnapshotStore({ storageRoot })

    expect(await store.readLatest('session-1')).toBeUndefined()

    const snapshotPath = snapshotFilePath(storageRoot, 'session-1')
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, '{bad json', 'utf8')
    expect(await store.readLatest('session-1')).toBeUndefined()
  })
})

describe('EventStore', () => {
  test('uses a filesystem-safe directory while preserving envelope session ids', async () => {
    const storageRoot = await createTempRoot()
    const store = new EventStore({ storageRoot })
    const sessionId = 'matcha-agent:default:session-1'

    const envelope = await store.append(
      sessionId,
      createMessageStartedEvent('message-1'),
    )

    expect(envelope.sessionId).toBe(sessionId)
    expect(await store.replay(sessionId)).toEqual([envelope])
    await expect(
      stat(eventsFilePath(storageRoot, sessionId)),
    ).resolves.toBeDefined()
  })

  test('serializes concurrent appends with monotonic seq and unchanged replay filtering', async () => {
    const storageRoot = await createTempRoot()
    const store = new EventStore({ storageRoot })

    const [first, second, third] = await Promise.all([
      store.append('session-1', createMessageStartedEvent('message-1')),
      store.append('session-1', createMessageStartedEvent('message-2')),
      store.append('session-1', createMessageStartedEvent('message-3')),
    ])

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
    expect(
      (await store.replay('session-1', { afterSeq: 1, limit: 1 })).map(
        envelope => envelope.seq,
      ),
    ).toEqual([2])
  })

  test('does not reread existing event log after initializing latest seq', async () => {
    const storageRoot = await createTempRoot()
    const store = new EventStore({ storageRoot })
    const sessionId = 'session-1'
    const eventPath = eventsFilePath(storageRoot, sessionId)
    await mkdir(dirname(eventPath), { recursive: true })
    await writeFile(
      eventPath,
      `${JSON.stringify(
        createEventEnvelope(
          sessionId,
          7,
          createMessageStartedEvent('existing'),
        ),
      )}\n`,
      'utf8',
    )

    const first = await store.append(
      sessionId,
      createMessageStartedEvent('message-8'),
    )
    await appendFile(eventPath, '{bad json\n', 'utf8')
    const second = await store.append(
      sessionId,
      createMessageStartedEvent('message-9'),
    )

    expect([first.seq, second.seq]).toEqual([8, 9])
  })
})

describe('BlobStore', () => {
  test('uses a filesystem-safe directory while preserving blob reads by session id', async () => {
    const storageRoot = await createTempRoot()
    const store = new BlobStore({ storageRoot })
    const sessionId = 'matcha-agent:default:session-1'

    const blobRef = await store.writeText(sessionId, 'hello')

    expect(
      new TextDecoder().decode(await store.read(sessionId, blobRef.blobId)),
    ).toBe('hello')
    await expect(
      stat(blobFilePath(storageRoot, sessionId, blobRef.blobId)),
    ).resolves.toBeDefined()
  })

  test('keeps duplicate content ref stable without overwriting the blob file', async () => {
    const storageRoot = await createTempRoot()
    const store = new BlobStore({ storageRoot })
    const sessionId = 'session-1'

    const firstRef = await store.writeText(sessionId, 'same content')
    const path = blobFilePath(storageRoot, sessionId, firstRef.blobId)
    const stableTime = new Date('2026-01-01T00:00:00.000Z')
    await utimes(path, stableTime, stableTime)
    const beforeDuplicateWrite = await stat(path)

    const secondRef = await store.writeText(sessionId, 'same content')
    const afterDuplicateWrite = await stat(path)

    expect(secondRef).toEqual(firstRef)
    expect(afterDuplicateWrite.mtimeMs).toBe(beforeDuplicateWrite.mtimeMs)
    const storedBytes = await store.read(sessionId, firstRef.blobId)
    expect(new TextDecoder().decode(storedBytes)).toBe('same content')
  })
})

async function readSessionIds(index: SessionIndex): Promise<string[]> {
  const records = await index.readAll()
  return records.map(record => record.sessionId).sort()
}

function createSessionRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    workspaceRoot: join('workspace', sessionId),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtime: 'matcha-agent',
    lastSeq: 0,
    lastSnapshotVersion: 0,
    workerState: { state: 'unloaded', reason: 'notStarted' },
  }
}

function createSessionSnapshot(
  sessionId: string,
  version: number,
): SessionSnapshot {
  return {
    session: {
      ...createSessionRecord(sessionId),
      lastSeq: version,
      lastSnapshotVersion: version,
    },
    version,
    updatedAt: `2026-01-01T00:00:0${version}.000Z`,
    runs: [],
    messages: [],
    pendingApprovals: [],
  }
}

function indexFilePath(storageRoot: string): string {
  return join(storageRoot, 'sessions', 'index.json')
}

function snapshotFilePath(storageRoot: string, sessionId: string): string {
  return join(
    storageRoot,
    'sessions',
    sessionStorageDirectoryName(sessionId),
    'snapshot.json',
  )
}

function eventsFilePath(storageRoot: string, sessionId: string): string {
  return join(
    storageRoot,
    'sessions',
    sessionStorageDirectoryName(sessionId),
    'events.jsonl',
  )
}

function blobFilePath(
  storageRoot: string,
  sessionId: string,
  blobId: string,
): string {
  return join(
    storageRoot,
    'sessions',
    sessionStorageDirectoryName(sessionId),
    'blobs',
    blobId,
  )
}

function createMessageStartedEvent(messageId: string): AppServerEvent {
  return { type: 'message.started', messageId, role: 'assistant' }
}

function createEventEnvelope(
  sessionId: string,
  seq: number,
  event: AppServerEvent,
) {
  return {
    eventId: `event-${seq}`,
    sessionId,
    seq,
    createdAt: `2026-01-01T00:00:${seq}.000Z`,
    event,
  }
}
