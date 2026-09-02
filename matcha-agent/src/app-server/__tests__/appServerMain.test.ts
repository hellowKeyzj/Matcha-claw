import { afterEach, describe, expect, test } from 'bun:test'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import {
  createDefaultAppServerServices as createDefaultAppServerServicesBase,
  type AppServerServices,
  type AppServerSessionHistoryStore,
} from '../main.js'
import type { ClientHubSend } from '../transport/clientHub.js'
import { ClientHub } from '../transport/clientHub.js'
import type {
  AppServerConfig,
  WorkerCommand,
  WorkerFrame,
} from '../protocol/types.js'
import { encodeWorkerFrame } from '../workers/workerProtocol.js'
import type {
  WorkerChildProcess,
  WorkerProcessSpawn,
} from '../workers/workerProcess.js'
import type { SessionHistorySummary } from '../../utils/sessionHistoryReadModel.js'

class WritableSink extends Writable {
  readonly chunks: string[] = []

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }
}

type FakeWorkerChild = WorkerChildProcess & {
  readonly assignedWorkerId: string
  killCount: number
  emitFrame(frame: WorkerFrame): void
  emitExit(exitCode: number | null, signal: NodeJS.Signals | null): void
  hasExited(): boolean
  writtenCommands(): WorkerCommand[]
}

const tempRoots: string[] = []
const appServerServices: AppServerServices[] = []
const fakeWorkerChildren: FakeWorkerChild[] = []

afterEach(async () => {
  const services = appServerServices.splice(0)
  await shutdownAppServerServices(services)
  await shutdownAppServerServices(services)
  for (const child of fakeWorkerChildren.splice(0)) {
    child.emitExit(0, null)
  }

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matcha-app-server-'))
  tempRoots.push(root)
  return root
}

function createDefaultAppServerServices(
  options: Parameters<typeof createDefaultAppServerServicesBase>[0],
): AppServerServices {
  const services = createDefaultAppServerServicesBase(options)
  appServerServices.push(services)
  return services
}

async function shutdownAppServerServices(
  services: readonly AppServerServices[],
): Promise<void> {
  let complete = false
  let completionError: unknown
  const completed = Promise.all(
    services.map(services => services.shutdown()),
  ).then(
    () => {
      complete = true
    },
    error => {
      complete = true
      completionError = error
    },
  )
  const answeredShutdownIds = new Set<string>()

  for (let attempt = 0; attempt < 5 && !complete; attempt++) {
    answerFakeWorkerShutdowns(answeredShutdownIds)
    await Promise.resolve()
  }
  answerFakeWorkerShutdowns(answeredShutdownIds)
  await completed
  if (completionError) throw completionError
}

function answerFakeWorkerShutdowns(answeredShutdownIds: Set<string>): void {
  for (const child of fakeWorkerChildren) {
    if (child.hasExited()) continue
    for (const command of child.writtenCommands()) {
      if (
        command.type !== 'worker.shutdown' ||
        answeredShutdownIds.has(command.id)
      ) {
        continue
      }
      answeredShutdownIds.add(command.id)
      child.emitFrame({ id: command.id, ok: true })
      child.emitExit(0, null)
    }
  }
}

function createFakeWorkerChild(assignedWorkerId: string): FakeWorkerChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new WritableSink()

  let exited = false
  const emitExit = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (exited) return
    exited = true
    emitter.emit('exit', exitCode, signal)
  }

  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    assignedWorkerId,
    killCount: 0,
    kill: () => true,
    emitFrame: (frame: WorkerFrame) => {
      stdout.emit('data', Buffer.from(encodeWorkerFrame(frame), 'utf8'))
    },
    emitExit,
    hasExited: () => exited,
    writtenCommands: () =>
      stdin.chunks
        .join('')
        .split(/\r?\n/)
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as WorkerCommand),
  })
  child.kill = () => {
    child.killCount += 1
    child.emitExit(null, 'SIGTERM')
    return true
  }
  fakeWorkerChildren.push(child)
  return child
}

function createTestConfig(storageRoot: string): AppServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    storageRoot,
    workerCommand: 'fake-worker',
    workerArgs: ['--matcha-agent-worker-entry'],
    workerReadyTimeoutMs: 100,
    workerHeartbeatTimeoutMs: 60_000,
    maxClientQueueSize: 16,
  }
}

async function withProcessEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map(
    Object.keys(patch).map(key => [key, process.env[key]]),
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function createHistoryStore(
  summaries: SessionHistorySummary[],
): AppServerSessionHistoryStore {
  return {
    list: async () => summaries,
    load: async sessionId =>
      summaries.find(summary => summary.sessionId === sessionId) ?? null,
    transcript: async sessionId => ({
      lines: summaries.some(summary => summary.sessionId === sessionId)
        ? [
            JSON.stringify({
              timestamp: '2026-01-01T00:00:00.000Z',
              message: {
                role: 'user',
                content: 'historical prompt',
                id: 'history-user-message',
              },
            }),
          ]
        : [],
    }),
  }
}

function waitForWorkerCommand(
  child: FakeWorkerChild,
  type: WorkerCommand['type'],
): Promise<WorkerCommand> {
  return waitFor(() =>
    child.writtenCommands().find(command => command.type === type),
  )
}

async function waitFor<T>(
  readValue: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await readValue()
    if (value !== undefined) return value
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for expected value')
}

type ClientHubEventNotification = {
  jsonrpc: '2.0'
  method: 'event'
  params: {
    sessionId: string
    seq: number
    event: { type: string }
  }
}

function parseClientHubEventNotification(
  payload: string,
): ClientHubEventNotification {
  const parsed: unknown = JSON.parse(payload)
  if (
    !isRecord(parsed) ||
    parsed.jsonrpc !== '2.0' ||
    parsed.method !== 'event' ||
    'id' in parsed
  ) {
    throw new Error('Expected an event JSON-RPC notification')
  }

  const params = parsed.params
  if (
    !isRecord(params) ||
    typeof params.sessionId !== 'string' ||
    typeof params.seq !== 'number' ||
    !Number.isFinite(params.seq) ||
    !isRecord(params.event) ||
    typeof params.event.type !== 'string'
  ) {
    throw new Error('Expected an app-server event notification envelope')
  }

  return {
    jsonrpc: parsed.jsonrpc,
    method: parsed.method,
    params: {
      sessionId: params.sessionId,
      seq: params.seq,
      event: { type: params.event.type },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('createDefaultAppServerServices', () => {
  test('spawns workers with inherited process env plus trace, toolchain, and worker id', async () => {
    const storageRoot = await createTempRoot()
    const spawnedEnvs: NodeJS.ProcessEnv[] = []
    await withProcessEnv(
      {
        MATCHACLAW_SESSION_TRACE: '1',
        MATCHA_AGENT_RUN_TRACE: '1',
        PATH: 'C:\\Python312;C:\\Windows\\System32',
        Path: 'C:\\Python312;C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        TEMP: 'C:\\Temp',
        TMP: 'C:\\Temp',
        SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
        MATCHACLAW_UV_BIN: 'C:\\toolchain\\uv.exe',
        MATCHA_AGENT_WORKER_ID: 'parent-worker-id',
      },
      async () => {
        const services = createDefaultAppServerServices({
          config: createTestConfig(storageRoot),
          clientHub: new ClientHub({ maxClientQueueSize: 16 }),
          serverVersion: 'test-server',
          spawnWorker: ((
            _command,
            _args,
            options: SpawnOptionsWithoutStdio,
          ) => {
            spawnedEnvs.push(options.env ?? {})
            return createFakeWorkerChild(
              String(options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
            )
          }) as WorkerProcessSpawn,
          createWorkerRequestId: sequentialIds('worker-request'),
        })

        await services.ports.session.create({
          cwd: storageRoot,
          sessionId: 'session-env',
        })
        await services.ports.session.prompt({
          sessionId: 'session-env',
          prompt: 'hello',
        })
      },
    )

    expect(spawnedEnvs).toHaveLength(1)
    const env = spawnedEnvs[0]!
    expect(env.MATCHACLAW_SESSION_TRACE).toBe('1')
    expect(env.MATCHA_AGENT_RUN_TRACE).toBe('1')
    expect(env.PATH ?? env.Path).toContain('C:\\Python312')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(env.PATHEXT).toContain('.EXE')
    expect(env.TEMP).toBe('C:\\Temp')
    expect(env.TMP).toBe('C:\\Temp')
    expect(env.SHELL).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    )
    expect(env.MATCHACLAW_UV_BIN).toBe('C:\\toolchain\\uv.exe')
    expect(env.MATCHA_AGENT_WORKER_ID).toBeString()
    expect(env.MATCHA_AGENT_WORKER_ID).not.toBe('parent-worker-id')
  })

  test('creates sessions, queues prompts, persists events, and drains worker runs', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const sentEvents: string[] = []
    const clientHub = new ClientHub({ maxClientQueueSize: 16 })
    const clientId = clientHub.registerClient(
      ((payload: string) => {
        sentEvents.push(payload)
      }) as ClientHubSend,
      'client-1',
    )

    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub,
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    expect(
      clientHub.subscribe({ clientId, sessionId: 'session-1', lastSeq: 0 }),
    ).toMatchObject({
      resultType: 'subscribed',
      clientId,
      sessionId: 'session-1',
      lastSeq: 0,
    })

    const session = await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
      title: 'App Server Test',
      model: 'opus',
    })
    expect(session).toMatchObject({
      sessionId: 'session-1',
      title: 'App Server Test',
      model: 'opus',
      workerState: { state: 'unloaded', reason: 'notStarted' },
    })
    expect(session.hasConversation).toBeUndefined()
    const subscribeResult = await services.ports.events.subscribe(clientId, {
      sessionId: 'session-1',
      afterSeq: 0,
    })
    expect(subscribeResult).toEqual({
      resultType: 'subscribed',
      clientId,
      sessionId: 'session-1',
      afterSeq: 0,
      lastSeq: session.lastSeq,
    })
    expect(subscribeResult).not.toHaveProperty('replayed')

    const promptPayload = {
      message: 'hello\n\n[media attached: image.png]',
      attachments: [
        {
          content: 'base64-image',
          mimeType: 'image/png',
          fileName: 'image.png',
        },
      ],
    }
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'hello',
      payload: promptPayload,
    })
    expect(prompted.runId).toBeString()
    await expect(services.ports.session.list()).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId: 'session-1',
          hasConversation: true,
        }),
      ],
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = (await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )) as Extract<WorkerCommand, { type: 'worker.initialize' }>
    expect(initializeCommand.payload).toMatchObject({
      sessionId: 'session-1',
      cwd: storageRoot,
      model: 'opus',
    })

    worker.emitFrame({
      id: initializeCommand.id,
      ok: true,
      result: { workerId: worker.assignedWorkerId, pid: 12345 },
    })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })

    const promptCommand = (await waitForWorkerCommand(
      worker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    expect(promptCommand).toMatchObject({
      runId: prompted.runId,
      prompt: 'hello',
      payload: promptPayload,
    })
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'run.started',
        runId: prompted.runId,
        workerId: worker.assignedWorkerId,
      },
    })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'message.delta',
        messageId: 'message-1',
        delta: 'hello back',
      },
    })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompted.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const replayed = await services.ports.events.replay?.({
        sessionId: 'session-1',
      })
      return replayed?.events.some(
        event => event.event.type === 'run.completed',
      )
        ? true
        : undefined
    })

    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({ type: 'completed' }),
      }),
    )
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'message.delta',
          delta: 'hello back',
        }),
      }),
    )

    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(replayed?.events.map(event => event.event.type)).toEqual([
      'session.created',
      'run.queued',
      'worker.ready',
      'run.started',
      'message.delta',
      'run.completed',
    ])
    await waitFor(() =>
      sentEvents
        .map(parseClientHubEventNotification)
        .some(
          notification => notification.params.event.type === 'run.completed',
        )
        ? true
        : undefined,
    )
    const eventNotifications = sentEvents.map(parseClientHubEventNotification)
    expect(
      eventNotifications.map(notification => notification.params.sessionId),
    ).toEqual(Array(eventNotifications.length).fill('session-1'))
    expect(
      eventNotifications.map(notification => notification.params.seq),
    ).toEqual(eventNotifications.map((_, index) => index + 1))
    expect(
      eventNotifications.map(notification => notification.params.event.type),
    ).toEqual([
      'session.created',
      'run.queued',
      'worker.ready',
      'run.started',
      'message.delta',
      'run.completed',
    ])
    expect(workerChildren[0]?.killCount).toBe(0)
  })

  test('marks a queued run failed when worker initialization fails', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'hello',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({
      id: initializeCommand.id,
      ok: false,
      error: {
        type: 'internal',
        message:
          "Cannot find module '@claude-code-best/builtin-tools/tools/SendMessageTool/SendMessageTool.js'",
        retryable: false,
      },
    })

    const snapshot = await waitFor(async () => {
      const current = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return current.runs.some(run => run.status.type === 'failed')
        ? current
        : undefined
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({
          type: 'failed',
          error: expect.objectContaining({
            type: 'internal',
            retryable: false,
            message: expect.stringContaining('SendMessageTool'),
          }),
        }),
      }),
    )
    expect(worker.killCount).toBe(1)
    expect(
      worker
        .writtenCommands()
        .some(command => command.type === 'session.prompt'),
    ).toBe(false)

    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(replayed?.events.map(event => event.event.type)).toEqual([
      'session.created',
      'run.queued',
      'run.failed',
    ])
  })

  test('rejects sensitive workspace roots before creating sessions', async () => {
    const storageRoot = await createTempRoot()
    const gitWorkspace = join(storageRoot, '.git')
    await mkdir(gitWorkspace)
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await expect(
      services.ports.session.create({
        cwd: gitWorkspace,
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('Workspace unavailable:')
    await expect(services.ports.session.list()).resolves.toEqual({
      sessions: [],
    })
  })

  test('keeps history-only sessions out of app-server runtime index while reading', async () => {
    const storageRoot = await createTempRoot()
    const historyStore = createHistoryStore([
      {
        sessionId: 'history-session-1',
        workspaceRoot: storageRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        title: 'History Session',
        hasConversation: true,
      },
    ])
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      sessionHistoryStore: historyStore,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    const listed = await services.ports.session.list()
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({
      sessionId: 'history-session-1',
      title: 'History Session',
      hasConversation: true,
      lastSeq: 0,
      workerState: { state: 'unloaded', reason: 'notStarted' },
    })

    const loaded = await services.ports.session.load({
      sessionId: 'history-session-1',
    })
    expect(loaded).toMatchObject({
      sessionId: 'history-session-1',
      title: 'History Session',
      hasConversation: true,
      lastSeq: 0,
    })

    const transcript = await services.ports.session.transcript({
      sessionId: 'history-session-1',
    })
    expect(transcript.lines).toHaveLength(1)

    const snapshot = await services.ports.session.snapshot({
      sessionId: 'history-session-1',
    })
    expect(snapshot.version).toBe(0)
    expect(snapshot.messages).toEqual([])

    const restartedWithoutHistory = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      createWorkerRequestId: sequentialIds('worker-request'),
    })
    await expect(restartedWithoutHistory.ports.session.list()).resolves.toEqual(
      {
        sessions: [],
      },
    )
  })

  test('prompts history-only sessions through the worker protocol', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      sessionHistoryStore: createHistoryStore([
        {
          sessionId: 'history-session-2',
          workspaceRoot: storageRoot,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          title: 'History Session',
        },
      ]),
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    const prompted = await services.ports.session.prompt({
      sessionId: 'history-session-2',
      prompt: 'continue history',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = (await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )) as Extract<WorkerCommand, { type: 'worker.initialize' }>
    expect(initializeCommand.payload).toMatchObject({
      sessionId: 'history-session-2',
      cwd: storageRoot,
    })
    expect('initialMessages' in initializeCommand.payload).toBe(false)

    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = (await waitForWorkerCommand(
      worker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    expect(promptCommand).toMatchObject({
      runId: prompted.runId,
      prompt: 'continue history',
    })
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompted.runId,
      stopReason: 'end_turn',
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'history-session-2',
      })
      return snapshot.runs.some(
        run => run.runId === prompted.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })
  })

  test('recovers nonterminal runs and approvals as terminal after restart', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const liveEvents: string[] = []
    const firstClientHub = new ClientHub({ maxClientQueueSize: 16 })
    const clientId = firstClientHub.registerClient(
      ((payload: string) => {
        liveEvents.push(payload)
      }) as ClientHubSend,
      'recovery-client',
    )
    expect(
      firstClientHub.subscribe({
        clientId,
        sessionId: 'session-1',
        lastSeq: 0,
      }),
    ).toMatchObject({
      resultType: 'subscribed',
      clientId,
      sessionId: 'session-1',
      lastSeq: 0,
    })
    const firstServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: firstClientHub,
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await firstServices.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await firstServices.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'lost after restart',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'run.started',
        runId: prompted.runId,
        workerId: worker.assignedWorkerId,
      },
    })
    await waitFor(() =>
      liveEvents
        .map(parseClientHubEventNotification)
        .some(notification => notification.params.event.type === 'run.started')
        ? true
        : undefined,
    )

    const recoveredServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    const loaded = await recoveredServices.ports.session.load({
      sessionId: 'session-1',
    })
    expect(loaded.workerState).toEqual({
      state: 'unloaded',
      reason: 'notStarted',
    })

    const snapshot = await recoveredServices.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({
          type: 'interrupted',
          reason: 'serverShutdown',
        }),
      }),
    )
    const replayed = await recoveredServices.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(replayed?.events.map(event => event.event.type)).toContain(
      'run.interrupted',
    )
  })

  test('recovers persisted logical sessions through session.list after restart', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const sentEvents: string[] = []
    const firstClientHub = new ClientHub({ maxClientQueueSize: 16 })
    const clientId = firstClientHub.registerClient(
      ((payload: string) => {
        sentEvents.push(payload)
      }) as ClientHubSend,
      'client-1',
    )
    const firstServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: firstClientHub,
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await firstServices.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
      title: 'Persisted Session',
      model: 'opus',
      permissionMode: 'acceptEdits',
    })
    await expect(
      firstServices.ports.session.setModel({
        sessionId: 'session-1',
        model: 'opus',
        modelSelectionId: 'anthropic/opus',
        providerFingerprint: 'matcha-provider:v1:opus',
      }),
    ).resolves.toMatchObject({
      model: 'opus',
      modelSelectionId: 'anthropic/opus',
      providerFingerprint: 'matcha-provider:v1:opus',
    })
    expect(
      firstClientHub.subscribe({
        clientId,
        sessionId: 'session-1',
        lastSeq: 0,
      }),
    ).toMatchObject({
      resultType: 'subscribed',
      clientId,
      sessionId: 'session-1',
      lastSeq: 0,
    })
    const prompted = await firstServices.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'secret prompt body',
      payload: { body: 'secret payload' },
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'message.delta',
        messageId: 'message-1',
        delta: 'assistant reply',
      },
    })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompted.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const snapshot = await firstServices.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run => run.runId === prompted.runId && run.status.type === 'completed',
      ) &&
        sentEvents.some(payload => payload.includes('"type":"run.completed"'))
        ? snapshot
        : undefined
    })

    const indexPath = join(storageRoot, 'sessions', 'index.json')
    const persistedIndex = JSON.parse(
      await readFile(indexPath, 'utf8'),
    ) as Array<Record<string, unknown>>
    await writeFile(
      indexPath,
      `${JSON.stringify(
        persistedIndex.map(record => {
          delete record.hasConversation
          return record
        }),
      )}\n`,
      'utf8',
    )

    const recoveredServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    const listed = await recoveredServices.ports.session.list()
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'Persisted Session',
      model: 'opus',
      modelSelectionId: 'anthropic/opus',
      providerFingerprint: 'matcha-provider:v1:opus',
      permissionMode: 'acceptEdits',
      workerState: { state: 'unloaded', reason: 'notStarted' },
    })
    expect(listed.sessions[0]?.lastSeq).toBeGreaterThan(1)
    expect(listed.sessions[0]?.hasConversation).toBe(true)
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toContainEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        hasConversation: true,
      }),
    )
    expect(JSON.stringify(listed)).not.toContain('secret prompt body')
    expect(JSON.stringify(listed)).not.toContain('secret payload')

    const snapshot = await recoveredServices.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.session).toMatchObject({
      model: 'opus',
      modelSelectionId: 'anthropic/opus',
      providerFingerprint: 'matcha-provider:v1:opus',
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({ type: 'completed' }),
      }),
    )
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'message.delta',
          delta: 'assistant reply',
        }),
      }),
    )
  })

  test('continues a recovered session through the same session worker protocol', async () => {
    const storageRoot = await createTempRoot()
    const firstWorkerChildren: FakeWorkerChild[] = []
    const firstServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        firstWorkerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await firstServices.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const firstPrompted = await firstServices.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'old question',
    })
    const firstWorker = await waitFor(() => firstWorkerChildren[0])
    const firstInitializeCommand = await waitForWorkerCommand(
      firstWorker,
      'worker.initialize',
    )
    firstWorker.emitFrame({ id: firstInitializeCommand.id, ok: true })
    firstWorker.emitFrame({
      type: 'worker.ready',
      workerId: firstWorker.assignedWorkerId,
      pid: 12345,
    })
    const firstPromptCommand = await waitForWorkerCommand(
      firstWorker,
      'session.prompt',
    )
    firstWorker.emitFrame({ id: firstPromptCommand.id, ok: true })
    firstWorker.emitFrame({
      type: 'event',
      runId: firstPrompted.runId,
      event: {
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'user',
          uuid: 'history-user-message',
          message: { role: 'user', content: 'old question' },
          content: 'old question',
        },
      },
    })
    firstWorker.emitFrame({
      type: 'event',
      runId: firstPrompted.runId,
      event: {
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'assistant',
          uuid: 'history-assistant-message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'old answer' }],
          },
          content: [{ type: 'text', text: 'old answer' }],
        },
      },
    })
    firstWorker.emitFrame({
      type: 'event',
      runId: firstPrompted.runId,
      event: {
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: { type: 'result', uuid: 'history-result-message' },
        projectionHints: { isTerminal: true },
      },
    })
    firstWorker.emitFrame({
      type: 'run.completed',
      runId: firstPrompted.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const snapshot = await firstServices.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run =>
          run.runId === firstPrompted.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })

    const recoveredWorkerChildren: FakeWorkerChild[] = []
    const recoveredServices = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        recoveredWorkerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await recoveredServices.ports.session.list()
    const secondPrompted = await recoveredServices.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'continue',
    })
    const recoveredWorker = await waitFor(() => recoveredWorkerChildren[0])
    const recoveredInitializeCommand = (await waitForWorkerCommand(
      recoveredWorker,
      'worker.initialize',
    )) as Extract<WorkerCommand, { type: 'worker.initialize' }>

    expect(recoveredInitializeCommand.payload).toMatchObject({
      sessionId: 'session-1',
      cwd: storageRoot,
    })
    expect('initialMessages' in recoveredInitializeCommand.payload).toBe(false)
    expect(JSON.stringify(recoveredInitializeCommand.payload)).not.toContain(
      'history-user-message',
    )

    recoveredWorker.emitFrame({ id: recoveredInitializeCommand.id, ok: true })
    recoveredWorker.emitFrame({
      type: 'worker.ready',
      workerId: recoveredWorker.assignedWorkerId,
      pid: 12345,
    })
    const secondPromptCommand = (await waitForWorkerCommand(
      recoveredWorker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    expect(secondPromptCommand).toMatchObject({
      runId: secondPrompted.runId,
      prompt: 'continue',
    })
  })

  test('round-trips approval requests through broker and worker response', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'needs approval',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'approval.request',
      request: {
        approvalId: 'approval-1',
        runId: prompted.runId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        prompt: 'Run command?',
        input: { command: 'bun test' },
        options: [
          { optionId: 'allow', label: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', label: 'Deny', kind: 'reject_once' },
        ],
      },
    })

    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.pendingApprovals.length === 1 ? snapshot : undefined
    })

    const responsePromise = services.ports.approval.respond({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      optionId: 'allow',
    })

    const approvalCommand = (await waitForWorkerCommand(
      worker,
      'approval.response',
    )) as Extract<WorkerCommand, { type: 'approval.response' }>
    expect(approvalCommand).toMatchObject({
      approvalId: 'approval-1',
      decision: { type: 'approved', optionId: 'allow' },
    })
    worker.emitFrame({ id: approvalCommand.id, ok: true })
    await expect(responsePromise).resolves.toMatchObject({
      resultType: 'responded',
    })

    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.pendingApprovals).toEqual([])
  })

  test('keeps pending approval open when worker response fails', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'needs approval',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'approval.request',
      request: {
        approvalId: 'approval-1',
        runId: prompted.runId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        prompt: 'Run command?',
        input: { command: 'bun test' },
        options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }],
      },
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.pendingApprovals.length === 1 ? snapshot : undefined
    })

    const responsePromise = services.ports.approval.respond({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      optionId: 'allow',
    })
    const approvalCommand = await waitForWorkerCommand(
      worker,
      'approval.response',
    )
    worker.emitFrame({
      id: approvalCommand.id,
      ok: false,
      error: { type: 'worker', message: 'send failed', retryable: true },
    })

    await expect(responsePromise).rejects.toThrow('send failed')
    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.pendingApprovals).toHaveLength(1)
    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(replayed?.events.map(event => event.event.type)).not.toContain(
      'approval.resolved',
    )
  })

  test('ignores late approval requests for inactive runs', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'finish before approval',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompted.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(run => run.status.type === 'completed')
        ? snapshot
        : undefined
    })

    worker.emitFrame({
      type: 'approval.request',
      request: {
        approvalId: 'late-approval',
        runId: prompted.runId,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        prompt: 'Run command?',
        input: { command: 'bun test' },
        options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }],
      },
    })

    await waitFor(async () => {
      const replayed = await services.ports.events.replay?.({
        sessionId: 'session-1',
      })
      return replayed?.events.some(
        event => event.event.type === 'error.reported',
      )
        ? replayed
        : undefined
    })
    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.pendingApprovals).toEqual([])
  })

  test('rejects session settings changes while a run is active', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'active',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    await waitForWorkerCommand(worker, 'session.prompt')

    await expect(
      services.ports.session.setModel({
        sessionId: 'session-1',
        model: 'opus',
      }),
    ).rejects.toThrow('Cannot update session settings while run')
    expect(
      worker
        .writtenCommands()
        .filter(command => command.type === 'worker.shutdown'),
    ).toHaveLength(0)
  })

  test('marks worker-owned cancellations terminal and keeps the worker ready', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'cancel me',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({
      id: initializeCommand.id,
      ok: true,
      result: { workerId: worker.assignedWorkerId, pid: 12345 },
    })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })

    const cancelPromise = services.ports.session.cancel({
      sessionId: 'session-1',
      runId: prompted.runId,
      reason: 'user stopped',
    })
    const cancelCommand = await waitForWorkerCommand(worker, 'session.cancel')
    worker.emitFrame({ id: cancelCommand.id, ok: true })
    await expect(cancelPromise).resolves.toMatchObject({
      workerResponse: { ok: true },
    })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'run.cancelled',
        runId: prompted.runId,
        reason: 'user stopped',
      },
    })

    const snapshot = await waitFor(async () => {
      const current = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return current.runs.some(run => run.status.type === 'cancelled')
        ? current
        : undefined
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({
          type: 'cancelled',
          reason: 'user stopped',
        }),
      }),
    )
    expect(snapshot.session.workerState).toMatchObject({
      state: 'ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(
      replayed?.events.filter(event => event.event.type === 'run.completed'),
    ).toHaveLength(0)
  })

  test('fails a run and restarts the worker when prompt dispatch times out', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: { ...createTestConfig(storageRoot), workerReadyTimeoutMs: 10 },
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const timedOutPrompt = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'will timeout',
    })

    const firstWorker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      firstWorker,
      'worker.initialize',
    )
    firstWorker.emitFrame({ id: initializeCommand.id, ok: true })
    firstWorker.emitFrame({
      type: 'worker.ready',
      workerId: firstWorker.assignedWorkerId,
      pid: 12345,
    })
    await waitForWorkerCommand(firstWorker, 'session.prompt')

    const failedSnapshot = await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      const runFailed = snapshot.runs.some(
        run =>
          run.runId === timedOutPrompt.runId && run.status.type === 'failed',
      )
      return runFailed && snapshot.session.workerState.state === 'crashed'
        ? snapshot
        : undefined
    })
    expect(failedSnapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: timedOutPrompt.runId,
        status: expect.objectContaining({ type: 'failed' }),
      }),
    )
    expect(failedSnapshot.session.workerState).toMatchObject({
      state: 'crashed',
      workerId: firstWorker.assignedWorkerId,
      restartable: true,
    })
    expect(firstWorker.killCount).toBe(1)

    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'after timeout',
    })
    const secondWorker = await waitFor(() => workerChildren[1])
    const secondInitialize = await waitForWorkerCommand(
      secondWorker,
      'worker.initialize',
    )
    secondWorker.emitFrame({ id: secondInitialize.id, ok: true })
    secondWorker.emitFrame({
      type: 'worker.ready',
      workerId: secondWorker.assignedWorkerId,
      pid: 12345,
    })
    const secondPrompt = (await waitForWorkerCommand(
      secondWorker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    expect(secondPrompt).toMatchObject({
      type: 'session.prompt',
      prompt: 'after timeout',
    })
    secondWorker.emitFrame({ id: secondPrompt.id, ok: true })
    secondWorker.emitFrame({
      type: 'run.completed',
      runId: secondPrompt.runId,
      stopReason: 'end_turn',
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run =>
          run.runId === secondPrompt.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })
  })

  test('cancels a worker-owned run when the cancel command fails', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: { ...createTestConfig(storageRoot), workerReadyTimeoutMs: 10 },
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'cancel me',
    })

    const firstWorker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      firstWorker,
      'worker.initialize',
    )
    firstWorker.emitFrame({ id: initializeCommand.id, ok: true })
    firstWorker.emitFrame({
      type: 'worker.ready',
      workerId: firstWorker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(
      firstWorker,
      'session.prompt',
    )
    firstWorker.emitFrame({ id: promptCommand.id, ok: true })

    const cancelPromise = services.ports.session.cancel({
      sessionId: 'session-1',
      runId: prompted.runId,
      reason: 'user stopped',
    })
    const cancelCommand = await waitForWorkerCommand(
      firstWorker,
      'session.cancel',
    )
    firstWorker.emitFrame({
      id: cancelCommand.id,
      ok: false,
      error: {
        type: 'worker',
        message: 'worker cancel request failed',
        retryable: true,
      },
    })
    await expect(cancelPromise).resolves.toMatchObject({
      cancelledRunIds: [prompted.runId],
      workerResponse: { ok: false },
    })

    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({
          type: 'cancelled',
          reason: 'user stopped',
        }),
      }),
    )
    expect(snapshot.session.workerState).toMatchObject({
      state: 'crashed',
      workerId: firstWorker.assignedWorkerId,
      restartable: true,
    })
    expect(firstWorker.killCount).toBe(1)

    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'after cancel timeout',
    })
    const secondWorker = await waitFor(() => workerChildren[1])
    const secondInitialize = await waitForWorkerCommand(
      secondWorker,
      'worker.initialize',
    )
    secondWorker.emitFrame({ id: secondInitialize.id, ok: true })
    secondWorker.emitFrame({
      type: 'worker.ready',
      workerId: secondWorker.assignedWorkerId,
      pid: 12345,
    })
    const secondPrompt = (await waitForWorkerCommand(
      secondWorker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    expect(secondPrompt).toMatchObject({
      type: 'session.prompt',
      prompt: 'after cancel timeout',
    })
    secondWorker.emitFrame({ id: secondPrompt.id, ok: true })
    secondWorker.emitFrame({
      type: 'run.completed',
      runId: secondPrompt.runId,
      stopReason: 'end_turn',
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run =>
          run.runId === secondPrompt.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })
  })

  test('returns after a cancel ack and waits for the worker terminal event', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'cancel ack only',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'run.started',
        runId: prompted.runId,
        workerId: worker.assignedWorkerId,
      },
    })

    const cancelPromise = services.ports.session.cancel({
      sessionId: 'session-1',
      runId: prompted.runId,
      reason: 'user stopped',
    })
    const cancelCommand = await waitForWorkerCommand(worker, 'session.cancel')
    worker.emitFrame({ id: cancelCommand.id, ok: true })
    await expect(cancelPromise).resolves.toMatchObject({
      cancelledRunIds: [],
      workerResponse: { ok: true },
    })

    const stoppingSnapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(stoppingSnapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({ type: 'running' }),
      }),
    )
    expect(stoppingSnapshot.session.workerState).toMatchObject({
      state: 'stopping',
      workerId: worker.assignedWorkerId,
      reason: 'cancel',
    })

    worker.emitFrame({
      type: 'event',
      runId: prompted.runId,
      event: {
        type: 'run.cancelled',
        runId: prompted.runId,
        reason: 'user stopped',
      },
    })

    const terminalSnapshot = await waitFor(async () => {
      const current = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return current.runs.some(
        run => run.runId === prompted.runId && run.status.type === 'cancelled',
      )
        ? current
        : undefined
    })
    expect(terminalSnapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: prompted.runId,
        status: expect.objectContaining({
          type: 'cancelled',
          reason: 'user stopped',
        }),
      }),
    )
    expect(terminalSnapshot.session.workerState).toMatchObject({
      state: 'ready',
      workerId: worker.assignedWorkerId,
    })
  })

  test('does not append cancelRequested for already terminal runs', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    const prompted = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'complete before cancel',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = await waitForWorkerCommand(worker, 'session.prompt')
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompted.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run => run.runId === prompted.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })
    await expect(
      services.ports.session.cancel({
        sessionId: 'session-1',
        runId: prompted.runId,
        reason: 'late stop',
      }),
    ).resolves.toMatchObject({
      cancelledRunIds: [],
      workerResponse: { ok: false },
    })

    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(
      replayed?.events.filter(
        event => event.event.type === 'run.cancelRequested',
      ),
    ).toHaveLength(0)
  })

  test('cancels queued runs without requiring a worker response', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'keep worker busy',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const activePromptCommand = await waitForWorkerCommand(
      worker,
      'session.prompt',
    )

    const queuedPrompt = await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'queued only',
    })

    await expect(
      services.ports.session.cancel({
        sessionId: 'session-1',
        runId: queuedPrompt.runId,
        reason: 'not needed',
      }),
    ).resolves.toMatchObject({
      cancelledRunIds: [queuedPrompt.runId],
      workerResponse: { ok: false },
    })
    worker.emitFrame({ id: activePromptCommand.id, ok: true })

    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: queuedPrompt.runId,
        status: expect.objectContaining({
          type: 'cancelled',
          reason: 'not needed',
        }),
      }),
    )
  })

  test('shuts down all warm workers when the app-server runtime stops', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    for (const sessionId of ['session-1', 'session-2']) {
      await services.ports.session.create({ cwd: storageRoot, sessionId })
      await services.ports.session.prompt({ sessionId, prompt: 'warm worker' })
    }

    const firstWorker = await waitFor(() => workerChildren[0])
    const secondWorker = await waitFor(() => workerChildren[1])
    for (const worker of [firstWorker, secondWorker]) {
      const initialize = await waitForWorkerCommand(worker, 'worker.initialize')
      worker.emitFrame({ id: initialize.id, ok: true })
      worker.emitFrame({
        type: 'worker.ready',
        workerId: worker.assignedWorkerId,
        pid: 12345,
      })
      const prompt = (await waitForWorkerCommand(
        worker,
        'session.prompt',
      )) as Extract<WorkerCommand, { type: 'session.prompt' }>
      worker.emitFrame({ id: prompt.id, ok: true })
      worker.emitFrame({
        type: 'run.completed',
        runId: prompt.runId,
        stopReason: 'end_turn',
      })
    }

    const shutdownPromise = services.shutdown()
    const firstShutdown = (await waitForWorkerCommand(
      firstWorker,
      'worker.shutdown',
    )) as Extract<WorkerCommand, { type: 'worker.shutdown' }>
    const secondShutdown = (await waitForWorkerCommand(
      secondWorker,
      'worker.shutdown',
    )) as Extract<WorkerCommand, { type: 'worker.shutdown' }>
    expect(firstShutdown.reason).toBe('serverShutdown')
    expect(secondShutdown.reason).toBe('serverShutdown')

    firstWorker.emitFrame({ id: firstShutdown.id, ok: true })
    secondWorker.emitFrame({ id: secondShutdown.id, ok: true })
    firstWorker.emitExit(0, null)
    secondWorker.emitExit(0, null)
    await shutdownPromise
  })

  test('closes sessions without resurrecting them in registry or index', async () => {
    const storageRoot = await createTempRoot()
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    await services.ports.session.close({ sessionId: 'session-1' })

    await expect(
      services.ports.session.load({ sessionId: 'session-1' }),
    ).rejects.toThrow('Session not found: session-1')
    await expect(services.ports.session.list()).resolves.toEqual({
      sessions: [],
    })

    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(replayed?.events.at(-1)?.event).toEqual({
      type: 'session.closed',
      sessionId: 'session-1',
    })
  })

  test('keeps heartbeat from overwriting the worker pid', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
    })
    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'hi',
    })

    const worker = await waitFor(() => workerChildren[0])
    const initializeCommand = await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )
    worker.emitFrame({ id: initializeCommand.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const promptCommand = (await waitForWorkerCommand(
      worker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    worker.emitFrame({ id: promptCommand.id, ok: true })
    worker.emitFrame({
      type: 'run.completed',
      runId: promptCommand.runId,
      stopReason: 'end_turn',
    })
    worker.emitFrame({
      type: 'worker.heartbeat',
      workerId: worker.assignedWorkerId,
    })

    await waitFor(async () => {
      const listed = await services.ports.session.list()
      return listed.sessions[0]?.workerState.state === 'ready'
        ? listed
        : undefined
    })
    const listed = await services.ports.session.list()
    expect(listed.sessions[0]?.workerState).toMatchObject({
      state: 'ready',
      pid: 12345,
    })
    await waitFor(async () => {
      const replayed = await services.ports.events.replay?.({
        sessionId: 'session-1',
      })
      return replayed?.events.some(
        event =>
          event.event.type === 'run.completed' &&
          event.event.runId === promptCommand.runId,
      )
        ? replayed
        : undefined
    })
  })

  test('updates warm worker model without restart for the same provider', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
      model: 'sonnet',
    })
    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'before model change',
    })

    const firstWorker = await waitFor(() => workerChildren[0])
    const firstInitialize = await waitForWorkerCommand(
      firstWorker,
      'worker.initialize',
    )
    firstWorker.emitFrame({ id: firstInitialize.id, ok: true })
    firstWorker.emitFrame({
      type: 'worker.ready',
      workerId: firstWorker.assignedWorkerId,
      pid: 12345,
    })
    const firstPrompt = (await waitForWorkerCommand(
      firstWorker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    firstWorker.emitFrame({ id: firstPrompt.id, ok: true })
    firstWorker.emitFrame({
      type: 'run.completed',
      runId: firstPrompt.runId,
      stopReason: 'end_turn',
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(
        run =>
          run.runId === firstPrompt.runId && run.status.type === 'completed',
      )
        ? snapshot
        : undefined
    })

    const setModelPromise = services.ports.session.setModel({
      sessionId: 'session-1',
      model: 'opus',
    })
    const setModelCommand = (await waitForWorkerCommand(
      firstWorker,
      'worker.setModel',
    )) as Extract<WorkerCommand, { type: 'worker.setModel' }>
    expect(setModelCommand.model).toBe('opus')
    firstWorker.emitFrame({ id: setModelCommand.id, ok: true })
    const updated = await setModelPromise
    expect(updated.model).toBe('opus')
    expect(
      firstWorker
        .writtenCommands()
        .filter(command => command.type === 'worker.shutdown'),
    ).toHaveLength(0)

    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'after model change',
    })
    expect(workerChildren).toHaveLength(1)
    const secondPrompt = (await waitFor(() => {
      const prompts = firstWorker
        .writtenCommands()
        .filter(command => command.type === 'session.prompt')
      return prompts[1]
    })) as Extract<WorkerCommand, { type: 'session.prompt' }>
    firstWorker.emitFrame({ id: secondPrompt.id, ok: true })
    firstWorker.emitFrame({
      type: 'run.completed',
      runId: secondPrompt.runId,
      stopReason: 'end_turn',
    })

    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(run => run.status.type === 'completed')
        ? snapshot
        : undefined
    })
  })

  test('restarts warm worker when provider fingerprint changes', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
      model: 'sonnet',
    })
    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'before provider change',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initialize = await waitForWorkerCommand(worker, 'worker.initialize')
    worker.emitFrame({ id: initialize.id, ok: true })
    worker.emitFrame({
      type: 'worker.ready',
      workerId: worker.assignedWorkerId,
      pid: 12345,
    })
    const prompt = (await waitForWorkerCommand(
      worker,
      'session.prompt',
    )) as Extract<WorkerCommand, { type: 'session.prompt' }>
    worker.emitFrame({ id: prompt.id, ok: true })
    worker.emitFrame({
      type: 'run.completed',
      runId: prompt.runId,
      stopReason: 'end_turn',
    })
    await waitFor(async () => {
      const snapshot = await services.ports.session.snapshot({
        sessionId: 'session-1',
      })
      return snapshot.runs.some(run => run.status.type === 'completed')
        ? snapshot
        : undefined
    })

    const setModel = services.ports.session.setModel({
      sessionId: 'session-1',
      model: 'opus',
      providerFingerprint: 'matcha-provider:v1:next',
    })
    const shutdown = (await waitForWorkerCommand(
      worker,
      'worker.shutdown',
    )) as Extract<WorkerCommand, { type: 'worker.shutdown' }>
    expect(shutdown.reason).toBe('restart')
    worker.emitFrame({ id: shutdown.id, ok: true })
    worker.emitExit(0, null)
    await expect(setModel).resolves.toMatchObject({
      model: 'opus',
      providerFingerprint: 'matcha-provider:v1:next',
    })
  })

  test('keeps provider runtime private and passes it only to worker initialization', async () => {
    const storageRoot = await createTempRoot()
    const workerChildren: FakeWorkerChild[] = []
    const services = createDefaultAppServerServices({
      config: createTestConfig(storageRoot),
      clientHub: new ClientHub({ maxClientQueueSize: 16 }),
      serverVersion: 'test-server',
      spawnWorker: ((_command, _args, _options: SpawnOptionsWithoutStdio) => {
        const child = createFakeWorkerChild(
          String(_options.env?.MATCHA_AGENT_WORKER_ID ?? ''),
        )
        workerChildren.push(child)
        return child
      }) as WorkerProcessSpawn,
      createWorkerRequestId: sequentialIds('worker-request'),
    })

    await services.ports.session.create({
      cwd: storageRoot,
      sessionId: 'session-1',
      model: 'sonnet',
    })
    const updated = await services.ports.session.setModel({
      sessionId: 'session-1',
      model: 'ark-code-latest',
      modelSelectionId: 'ark/ark-code-latest',
      providerFingerprint: 'matcha-provider:v1:ark',
      providerRuntime: {
        kind: 'openAiChatCompletions',
        baseUrl: 'https://ark.example/v1',
        apiKey: 'ark-secret',
      },
    })

    expect(updated).toMatchObject({
      model: 'ark-code-latest',
      modelSelectionId: 'ark/ark-code-latest',
      providerFingerprint: 'matcha-provider:v1:ark',
    })
    expect(JSON.stringify(updated)).not.toContain('ark-secret')
    expect(JSON.stringify(updated)).not.toContain('https://ark.example/v1')
    const snapshot = await services.ports.session.snapshot({
      sessionId: 'session-1',
    })
    expect(snapshot.session).toMatchObject({
      model: 'ark-code-latest',
      modelSelectionId: 'ark/ark-code-latest',
      providerFingerprint: 'matcha-provider:v1:ark',
    })
    expect(JSON.stringify(snapshot)).not.toContain('ark-secret')
    expect(JSON.stringify(snapshot)).not.toContain('https://ark.example/v1')
    const replayed = await services.ports.events.replay?.({
      sessionId: 'session-1',
    })
    expect(JSON.stringify(replayed)).not.toContain('ark-secret')
    expect(JSON.stringify(replayed)).not.toContain('https://ark.example/v1')

    await services.ports.session.prompt({
      sessionId: 'session-1',
      prompt: 'uses host provider runtime',
    })
    const worker = await waitFor(() => workerChildren[0])
    const initialize = (await waitForWorkerCommand(
      worker,
      'worker.initialize',
    )) as Extract<WorkerCommand, { type: 'worker.initialize' }>
    expect(initialize.payload.providerRuntime).toEqual({
      kind: 'openAiChatCompletions',
      baseUrl: 'https://ark.example/v1',
      apiKey: 'ark-secret',
    })
  })

  test('returns model options from existing model registry', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const storageRoot = await createTempRoot()
      const services = createDefaultAppServerServices({
        config: createTestConfig(storageRoot),
        clientHub: new ClientHub({ maxClientQueueSize: 16 }),
        serverVersion: 'test-server',
        createWorkerRequestId: sequentialIds('worker-request'),
      })

      const result = await services.ports.models.list({})
      expect(result.models).toContain('opus')
      expect(result.models).toContain('haiku')
      expect(result.models.length).toBeGreaterThan(1)
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }
  })
})

function sequentialIds(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}
