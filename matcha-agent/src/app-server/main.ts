import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerConfig,
  type AppServerEvent,
  type AppServerEventEnvelope,
  type ApprovalRecord,
  type ApprovalRespondParams,
  type ClassifiedError,
  type RunRecord,
  type SessionRecord,
  type SessionSnapshot,
  type StopReason,
  type UsageSummary,
  type WorkerApprovalRequest,
  type WorkerResponse,
  type WorkerRuntimeState,
} from './protocol/types.js'
import { parseAppServerConfig } from './config.js'
import { ApprovalBroker } from './approvals/approvalBroker.js'
import { RunCoordinator } from './sessions/runCoordinator.js'
import {
  SessionEventCommitter,
  type SessionEventFields,
  type SessionEventPostAppendStage,
} from './sessions/sessionEventCommitter.js'
import { SessionRegistry } from './sessions/sessionRegistry.js'
import {
  EventStore,
  SessionIndex,
  SnapshotStore,
  buildSessionSnapshot,
  reduceSessionSnapshot,
} from './stores/index.js'
import { ClientHub } from './transport/clientHub.js'
import type { AppServerPorts } from './transport/ports.js'
import { WsServer } from './transport/wsServer.js'
import type { WorkerProcessSpawn } from './workers/workerProcess.js'
import {
  classifyWorkerInitializationError,
  workerError,
  WorkerSupervisor,
} from './workers/workerSupervisor.js'
import {
  listSessionHistorySummaries,
  loadSessionHistorySummary,
  readSessionTranscriptReplayLines,
  type SessionHistorySummary,
} from '../utils/sessionHistoryReadModel.js'

const SESSION_HISTORY_LIST_LIMIT = 200
const SESSION_TRANSCRIPT_MAX_LINES = 10_000
const WORKER_SHUTDOWN_TIMEOUT_MS = 2_000

export type AppServerPortContext = {
  clientHub: ClientHub
  serverVersion: string
}

export type AppServerDeps = {
  config: AppServerConfig
  createServices: (context: AppServerPortContext) => AppServerServices
  serverVersion: string
}

export type AppServerRuntime = {
  config: AppServerConfig
  clientHub: ClientHub
  wsServer: WsServer
  start(): Bun.Server<unknown>
  stop(closeActiveConnections?: boolean): Promise<void>
}

export type AppServerServices = {
  ports: AppServerPorts
  workerSupervisor: WorkerSupervisor
  shutdown(): Promise<void>
}

export type AppServerSessionHistoryStore = {
  list(): Promise<SessionHistorySummary[]>
  load(sessionId: string): Promise<SessionHistorySummary | null>
  transcript(sessionId: string): Promise<{ lines: string[] }>
}

export function createAppServerRuntime(deps: AppServerDeps): AppServerRuntime {
  let wsServer: WsServer | undefined
  const clientHub = new ClientHub({
    maxClientQueueSize: deps.config.maxClientQueueSize,
    closeClient: (clientId, reason) => {
      wsServer?.closeClient(clientId, reason)
    },
  })
  const services = deps.createServices({
    clientHub,
    serverVersion: deps.serverVersion,
  })

  wsServer = new WsServer({
    config: deps.config,
    ports: services.ports,
    serverVersion: deps.serverVersion,
    clientHub,
  })

  let stopPromise: Promise<void> | undefined
  const stop = (closeActiveConnections = true): Promise<void> => {
    if (!stopPromise) {
      wsServer.stop(closeActiveConnections)
      stopPromise = services.shutdown()
    }
    return stopPromise
  }

  return {
    config: deps.config,
    clientHub,
    wsServer,
    start: () => wsServer.start(),
    stop,
  }
}

export function createDefaultAppServerServices(options: {
  config: AppServerConfig
  clientHub: ClientHub
  serverVersion: string
  spawnWorker?: WorkerProcessSpawn
  createWorkerRequestId?: () => string
  sessionHistoryStore?: AppServerSessionHistoryStore
}): AppServerServices {
  const eventStore = new EventStore({ storageRoot: options.config.storageRoot })
  const snapshotStore = new SnapshotStore({
    storageRoot: options.config.storageRoot,
  })
  const sessionIndex = new SessionIndex({
    storageRoot: options.config.storageRoot,
  })
  const sessionRegistry = new SessionRegistry()
  const runCoordinator = new RunCoordinator({ maxQueueSize: 16 })
  const approvalBroker = new ApprovalBroker()
  const drainingSessions = new Map<string, Promise<void>>()
  const pendingDrains = new Set<string>()
  const sessionHistoryStore =
    options.sessionHistoryStore ?? createEmptySessionHistoryStore()

  const sessionEventCommitter = new SessionEventCommitter({
    append: (sessionId, event, fields) =>
      eventStore.append(sessionId, event, fields),
    updateSessionMetadata: async envelope => {
      const updatedSession = updateSessionAfterEnvelope(sessionRegistry, envelope)
      if (updatedSession) {
        await sessionIndex.upsert(updatedSession)
      }
    },
    updateSnapshot: envelope =>
      updateSnapshotAfterEnvelope(snapshotStore, sessionRegistry, envelope),
    publish: envelope => options.clientHub.broadcast(envelope),
    reportPostAppendFailure: reportSessionEventPostAppendFailure,
  })

  const appendEvent = (
    sessionId: string,
    event: AppServerEvent,
    fields: SessionEventFields = {},
  ): Promise<AppServerEventEnvelope> =>
    sessionEventCommitter.commit(sessionId, event, fields)

  const scheduleDrain = (sessionId: string): void => {
    if (drainingSessions.has(sessionId)) {
      pendingDrains.add(sessionId)
      return
    }
    const drain = drainNextRun(sessionId).finally(() => {
      drainingSessions.delete(sessionId)
      if (pendingDrains.delete(sessionId)) {
        scheduleDrain(sessionId)
      }
    })
    drainingSessions.set(sessionId, drain)
    void drain.catch(error => {
      logAppServerError('drainNextRun', error)
    })
  }

  const workerSupervisor = new WorkerSupervisor({
    command: options.config.workerCommand,
    args: options.config.workerArgs,
    requestTimeoutMs: options.config.workerReadyTimeoutMs,
    heartbeatTimeoutMs: options.config.workerHeartbeatTimeoutMs,
    shutdownTimeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
    ...(options.spawnWorker !== undefined
      ? { spawnWorker: options.spawnWorker }
      : {}),
    ...(options.createWorkerRequestId !== undefined
      ? { createRequestId: options.createWorkerRequestId }
      : {}),
    ports: {
      onWorkerReady: event => {
        sessionRegistry.updateWorkerState(event.sessionId, {
          state: 'ready',
          workerId: event.workerId,
          pid: event.pid,
          lastHeartbeatAt: new Date().toISOString(),
        })
        void appendEvent(
          event.sessionId,
          { type: 'worker.ready', workerId: event.workerId, pid: event.pid },
          { workerId: event.workerId },
        ).catch(error => logAppServerError('worker.ready', error))
      },
      onHeartbeat: event => {
        updateWorkerHeartbeat(sessionRegistry, event.sessionId, event.workerId)
      },
      onEvent: event => {
        void handleWorkerEvent(event).catch(error =>
          logAppServerError('worker.event', error),
        )
      },
      onApprovalRequest: event => {
        void handleApprovalRequest(event).catch(error =>
          logAppServerError('approval.request', error),
        )
      },
      onRunCompleted: event => {
        void handleRunCompleted(event).catch(error =>
          logAppServerError('run.completed', error),
        )
      },
      onRunFailed: event => {
        void handleRunFailed(event).catch(error =>
          logAppServerError('run.failed', error),
        )
      },
      onCrash: event => {
        void handleWorkerCrash(event).catch(error =>
          logAppServerError('worker.crashed', error),
        )
      },
      onFatal: event => {
        void appendEvent(
          event.sessionId,
          { type: 'error.reported', error: event.error },
          { workerId: event.workerId },
        ).catch(error => logAppServerError('worker.fatal', error))
      },
      onProtocolError: event => {
        void appendEvent(
          event.sessionId,
          {
            type: 'error.reported',
            error: {
              type: 'worker',
              message: event.error.message,
              retryable: true,
              details: { raw: event.raw },
            },
          },
          { workerId: event.workerId },
        ).catch(error => logAppServerError('worker.protocol', error))
      },
    },
  })

  async function handleWorkerEvent(event: {
    sessionId: string
    workerId: string
    runId?: string
    event: AppServerEvent
  }): Promise<void> {
    if (isBrokerOwnedWorkerEvent(event.event)) return
    if (event.event.type === 'run.cancelRequested') return
    if (event.event.type === 'run.cancelled') {
      const cancelled = runCoordinator.cancel(
        event.event.runId,
        event.event.reason,
      )
      if (cancelled.resultType !== 'updated') return
      updateSessionWorkerReadyState(
        sessionRegistry,
        workerSupervisor,
        event.sessionId,
        event.workerId,
      )
      await appendEvent(event.sessionId, event.event, {
        runId: event.runId,
        workerId: event.workerId,
      })
      scheduleDrain(event.sessionId)
      return
    }
    await appendEvent(event.sessionId, event.event, {
      runId: event.runId,
      workerId: event.workerId,
    })
  }

  async function handleApprovalRequest(event: {
    sessionId: string
    workerId: string
    request: WorkerApprovalRequest
  }): Promise<void> {
    const approvalId = event.request.approvalId ?? crypto.randomUUID()
    const marked = runCoordinator.markWaitingForApproval(event.request.runId, [
      approvalId,
    ])
    if (marked.resultType !== 'updated') {
      await appendEvent(
        event.sessionId,
        {
          type: 'error.reported',
          error: invalidApprovalRequestError(event.request.runId),
        },
        { runId: event.request.runId, workerId: event.workerId },
      )
      return
    }

    const created = approvalBroker.create({
      ...event,
      request: { ...event.request, approvalId },
    })
    sessionRegistry.updateWorkerState(event.sessionId, {
      state: 'waitingForApproval',
      workerId: event.workerId,
      runId: created.approval.runId,
      approvalIds: [created.approval.approvalId],
    })
    await appendEvent(
      event.sessionId,
      { type: 'approval.requested', approval: created.approval },
      { runId: created.approval.runId, workerId: event.workerId },
    )
  }

  async function handleRunCompleted(event: {
    sessionId: string
    workerId: string
    runId: string
    stopReason: StopReason
    usage?: UsageSummary
  }): Promise<void> {
    const completed = runCoordinator.complete(event.runId, event.stopReason)
    if (completed.resultType === 'updated') {
      updateSessionWorkerReadyState(
        sessionRegistry,
        workerSupervisor,
        event.sessionId,
        event.workerId,
      )
      await appendEvent(
        event.sessionId,
        {
          type: 'run.completed',
          runId: event.runId,
          stopReason: event.stopReason,
          usage: event.usage,
        },
        { runId: event.runId, workerId: event.workerId },
      )
    }
    scheduleDrain(event.sessionId)
  }

  async function handleRunFailed(event: {
    sessionId: string
    workerId: string
    runId: string
    error: ClassifiedError
  }): Promise<void> {
    const failed = runCoordinator.fail(event.runId, event.error)
    if (failed.resultType === 'updated') {
      updateSessionWorkerReadyState(
        sessionRegistry,
        workerSupervisor,
        event.sessionId,
        event.workerId,
      )
      await appendEvent(
        event.sessionId,
        { type: 'run.failed', runId: event.runId, error: event.error },
        { runId: event.runId, workerId: event.workerId },
      )
    }
    scheduleDrain(event.sessionId)
  }

  async function handleWorkerCrash(event: {
    sessionId: string
    workerId: string
    exitCode?: number
    signal?: string
    stderrTail: string
  }): Promise<void> {
    sessionRegistry.updateWorkerState(event.sessionId, {
      state: 'crashed',
      workerId: event.workerId,
      exitCode: event.exitCode,
      signal: event.signal,
      restartable: true,
    })
    await appendEvent(
      event.sessionId,
      {
        type: 'worker.crashed',
        workerId: event.workerId,
        exitCode: event.exitCode,
        signal: event.signal,
      },
      { workerId: event.workerId },
    )
    for (const cancelled of approvalBroker.cancelByWorker(event.workerId)) {
      await appendEvent(
        cancelled.approval.sessionId,
        { type: 'approval.resolved', approval: cancelled.approval },
        { runId: cancelled.approval.runId, workerId: event.workerId },
      )
    }
    for (const run of runCoordinator.listRuns(event.sessionId)) {
      if (
        run.status.type !== 'running' &&
        run.status.type !== 'waitingForApproval'
      ) {
        continue
      }
      runCoordinator.interrupted(run.runId, 'workerCrashed')
      await appendEvent(
        event.sessionId,
        { type: 'run.interrupted', runId: run.runId, reason: 'workerCrashed' },
        { runId: run.runId, workerId: event.workerId },
      )
    }
  }

  async function drainNextRun(sessionId: string): Promise<void> {
    const loaded = await loadSessionRuntimeState(sessionId)
    if (!loaded || !hasQueuedSessionRun(sessionId)) return

    let worker: Awaited<ReturnType<WorkerSupervisor['ensureWorker']>>
    try {
      worker = await workerSupervisor.ensureWorker({
        sessionId: loaded.sessionId,
        cwd: loaded.workspaceRoot,
        model: loaded.model,
        permissionMode: loaded.permissionMode,
      })
    } catch (error) {
      await failNextQueuedRunStart(sessionId, error)
      scheduleDrain(sessionId)
      return
    }

    const started = runCoordinator.startNext(sessionId, worker.workerId)
    if (started.resultType !== 'started') return

    sessionRegistry.updateWorkerState(sessionId, {
      state: 'running',
      workerId: worker.workerId,
      runId: started.queuedRun.run.runId,
      startedAt:
        started.queuedRun.run.status.type === 'running'
          ? started.queuedRun.run.status.startedAt
          : new Date().toISOString(),
    })
    try {
      const response = await workerSupervisor.send(sessionId, {
        id: crypto.randomUUID(),
        type: 'session.prompt',
        runId: started.queuedRun.run.runId,
        prompt: started.queuedRun.prompt,
        ...(started.queuedRun.payload !== undefined
          ? { payload: started.queuedRun.payload }
          : {}),
      })
      if (response.ok) return

      markWorkerUnavailable(sessionId, worker.workerId)
      workerSupervisor.killSession(
        sessionId,
        `worker prompt request failed for session ${sessionId}`,
      )
      await failWorkerOwnedRun(
        sessionId,
        started.queuedRun.run.runId,
        worker.workerId,
        response.error,
      )
    } catch (error) {
      markWorkerUnavailable(sessionId, worker.workerId)
      workerSupervisor.killSession(
        sessionId,
        `worker prompt request failed for session ${sessionId}`,
      )
      await failWorkerOwnedRun(
        sessionId,
        started.queuedRun.run.runId,
        worker.workerId,
        workerError(error),
      )
    }
    scheduleDrain(sessionId)
  }

  async function failWorkerOwnedRun(
    sessionId: string,
    runId: string,
    workerId: string,
    error: ClassifiedError,
  ): Promise<void> {
    const failed = runCoordinator.fail(runId, error)
    if (failed.resultType !== 'updated') return

    await appendEvent(
      sessionId,
      { type: 'run.failed', runId, error },
      { runId, workerId },
    )
  }

  async function cancelWorkerOwnedRuns(
    sessionId: string,
    runIds: string[],
    workerId: string,
    reason: string,
  ): Promise<string[]> {
    const cancelledRunIds: string[] = []
    for (const runId of runIds) {
      const cancelled = runCoordinator.cancel(runId, reason)
      if (cancelled.resultType !== 'updated') continue
      cancelledRunIds.push(runId)
      await appendEvent(
        sessionId,
        { type: 'run.cancelled', runId, reason },
        { runId, workerId },
      )
    }
    return cancelledRunIds
  }

  function markWorkerUnavailable(sessionId: string, workerId: string): void {
    sessionRegistry.updateWorkerState(sessionId, {
      state: 'crashed',
      workerId,
      restartable: true,
    })
  }

  async function failNextQueuedRunStart(
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    const run = nextQueuedSessionRun(sessionId)
    if (!run) return

    const classified = classifyWorkerInitializationError(error)
    const failed = runCoordinator.failStart(run.runId, classified)
    if (failed.resultType !== 'updated') return

    await appendEvent(
      sessionId,
      { type: 'run.failed', runId: failed.run.runId, error: classified },
      { runId: failed.run.runId },
    )
  }

  async function loadSessionRuntimeState(
    sessionId: string,
  ): Promise<SessionRecord | undefined> {
    const loaded = sessionRegistry.load(sessionId)
    if (loaded.resultType === 'loaded') return loaded.session

    for (const record of await sessionIndex.readAll()) {
      if (record.sessionId !== sessionId) {
        sessionRegistry.upsert(record)
        continue
      }

      const recovered = await recoverSessionRuntimeState(record)
      return recovered
    }

    return undefined
  }

  async function loadSessionForRead(
    sessionId: string,
  ): Promise<SessionRecord | undefined> {
    const runtimeSession = await loadSessionRuntimeState(sessionId)
    if (runtimeSession) return runtimeSession

    const historySession = await sessionHistoryStore.load(sessionId)
    return historySession ? historySessionRecord(historySession) : undefined
  }

  async function ensureSessionRuntimeState(
    sessionId: string,
  ): Promise<SessionRecord | undefined> {
    const runtimeSession = await loadSessionRuntimeState(sessionId)
    if (runtimeSession) return runtimeSession

    const historySession = await sessionHistoryStore.load(sessionId)
    if (!historySession) return undefined

    return sessionRegistry.upsert(historySessionRecord(historySession))
  }

  async function ensureSessionExists(
    sessionId: string,
  ): Promise<SessionRecord> {
    const session = await loadSessionForRead(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  async function recoverSessionRuntimeState(
    record: SessionRecord,
  ): Promise<SessionRecord> {
    const events = await eventStore.replay(record.sessionId)
    const snapshot = buildSessionSnapshot(record, events)
    const session = sessionRegistry.upsert({
      ...snapshot.session,
      workerState: recoveredWorkerState(snapshot.session.workerState),
    })
    if (session.hasConversation && !record.hasConversation) {
      await sessionIndex.upsert(session)
    }

    for (const run of snapshot.runs) {
      runCoordinator.restore({ run })
    }
    for (const approval of snapshot.pendingApprovals) {
      approvalBroker.restore(approval)
    }

    await interruptRecoveredSessionRuns(session.sessionId, snapshot.runs)
    await cancelRecoveredApprovals(snapshot.pendingApprovals)
    return loadSessionRuntimeState(session.sessionId).then(
      loaded => loaded ?? session,
    )
  }

  async function interruptRecoveredSessionRuns(
    sessionId: string,
    runs: RunRecord[],
  ): Promise<void> {
    for (const run of runs) {
      if (!isNonTerminalRunStatus(run.status.type)) continue
      const interrupted = runCoordinator.interrupted(
        run.runId,
        'serverShutdown',
      )
      if (interrupted.resultType !== 'updated') continue
      await appendEvent(
        sessionId,
        { type: 'run.interrupted', runId: run.runId, reason: 'serverShutdown' },
        { runId: run.runId },
      )
    }
  }

  async function cancelRecoveredApprovals(
    approvals: ApprovalRecord[],
  ): Promise<void> {
    const recoveredRunIds = new Set(approvals.map(approval => approval.runId))
    for (const runId of recoveredRunIds) {
      for (const cancelled of approvalBroker.cancelByRun(runId)) {
        await appendEvent(
          cancelled.approval.sessionId,
          { type: 'approval.resolved', approval: cancelled.approval },
          {
            runId: cancelled.approval.runId,
            workerId: cancelled.approval.workerId,
          },
        )
      }
    }
  }

  const ports: AppServerPorts = {
    initialize: () => ({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      serverVersion: options.serverVersion,
      capabilities: {
        eventReplay: true,
        snapshots: true,
        approvals: true,
        sdkMessageEnvelope: true,
        blobStore: true,
        sessionTranscript: true,
      },
    }),
    session: {
      create: async params => {
        const created = await sessionRegistry.create(params)
        if (created.resultType !== 'created') {
          throw new Error(sessionCreateErrorMessage(created))
        }
        await appendEvent(created.session.sessionId, {
          type: 'session.created',
          session: created.session,
        })
        return loadSessionRuntimeState(created.session.sessionId).then(
          session => session ?? created.session,
        )
      },
      load: async params => {
        const session = await loadSessionForRead(params.sessionId)
        if (!session) throw new Error(`Session not found: ${params.sessionId}`)
        if (session.lastSeq > 0) {
          await appendEvent(session.sessionId, {
            type: 'session.loaded',
            session,
          })
          return loadSessionRuntimeState(session.sessionId).then(
            loaded => loaded ?? session,
          )
        }
        return session
      },
      list: async () => {
        for (const record of await sessionIndex.readAll()) {
          const loaded = sessionRegistry.load(record.sessionId)
          if (
            loaded.resultType !== 'loaded' ||
            record.lastSeq > loaded.session.lastSeq
          ) {
            await recoverSessionRuntimeState(record)
          }
        }
        return {
          sessions: mergeSessionRecords(
            sessionRegistry.list(),
            (await sessionHistoryStore.list()).map(historySessionRecord),
          ),
        }
      },
      close: async params => {
        const runtimeSession = await loadSessionRuntimeState(params.sessionId)
        if (!runtimeSession) return ensureSessionExists(params.sessionId)

        await cancelSessionApprovals(params.sessionId)
        await cancelSessionRuns(params.sessionId, 'session closed')
        await workerSupervisor.shutdownSession(params.sessionId)
        await appendEvent(params.sessionId, {
          type: 'session.closed',
          sessionId: params.sessionId,
        })
        await sessionIndex.remove(params.sessionId)
        sessionRegistry.close(params.sessionId)
        return runtimeSession
      },
      prompt: async params => {
        const session = await ensureSessionRuntimeState(params.sessionId)
        if (!session) throw new Error(`Session not found: ${params.sessionId}`)
        const enqueued = runCoordinator.enqueue(params)
        if (enqueued.resultType === 'duplicateRun') {
          return { runId: enqueued.runId }
        }
        if (enqueued.resultType === 'queueFull') {
          throw new Error(
            `Session ${params.sessionId} prompt queue is full (${enqueued.queuedCount}/${enqueued.maxQueueSize})`,
          )
        }
        await appendEvent(
          params.sessionId,
          { type: 'run.queued', run: enqueued.queuedRun.run },
          { runId: enqueued.queuedRun.run.runId },
        )
        scheduleDrain(params.sessionId)
        return { runId: enqueued.queuedRun.run.runId }
      },
      transcript: async params => {
        const transcript = await sessionHistoryStore.transcript(
          params.sessionId,
        )
        if (transcript.lines.length === 0) {
          await ensureSessionExists(params.sessionId)
        }
        return transcript
      },
      cancel: async params => {
        await ensureSessionExists(params.sessionId)
        const reason = params.reason ?? 'cancelled by client'
        const worker = workerSupervisor.getWorker(params.sessionId)
        const requestedRunIds = params.runId
          ? [params.runId]
          : nonTerminalSessionRuns(params.sessionId).map(run => run.runId)
        const cancelledRunIds: string[] = []
        const workerOwnedRunIds: string[] = []

        for (const runId of requestedRunIds) {
          const run = runCoordinator.getRun(runId)
          if (!run || !isNonTerminalRunStatus(run.status.type)) continue

          await cancelRunApprovals(runId)
          if (run.status.type !== 'queued' && worker) {
            workerOwnedRunIds.push(runId)
            continue
          }

          const cancelled = runCoordinator.cancel(runId, reason)
          if (cancelled.resultType !== 'updated') continue
          cancelledRunIds.push(runId)
          await appendEvent(
            params.sessionId,
            { type: 'run.cancelled', runId, reason },
            { runId },
          )
        }

        if (workerOwnedRunIds.length > 0 && worker) {
          sessionRegistry.updateWorkerState(params.sessionId, {
            state: 'stopping',
            workerId: worker.workerId,
            reason: 'cancel',
          })
          await appendEvent(
            params.sessionId,
            { type: 'run.cancelRequested', runId: params.runId, reason },
            { runId: params.runId, workerId: worker.workerId },
          )
        }

        let workerResponse: WorkerResponse
        if (workerOwnedRunIds.length > 0 && worker) {
          try {
            workerResponse = await workerSupervisor.send(params.sessionId, {
              id: crypto.randomUUID(),
              type: 'session.cancel',
              runId: params.runId,
              reason,
            })
            if (workerResponse.ok) {
              cancelledRunIds.push(
                ...(await cancelWorkerOwnedRuns(
                  params.sessionId,
                  workerOwnedRunIds,
                  worker.workerId,
                  reason,
                )),
              )
              updateSessionWorkerReadyState(
                sessionRegistry,
                workerSupervisor,
                params.sessionId,
                worker.workerId,
              )
            } else {
              markWorkerUnavailable(params.sessionId, worker.workerId)
              workerSupervisor.killSession(
                params.sessionId,
                `worker cancel request failed for session ${params.sessionId}`,
              )
              cancelledRunIds.push(
                ...(await cancelWorkerOwnedRuns(
                  params.sessionId,
                  workerOwnedRunIds,
                  worker.workerId,
                  reason,
                )),
              )
            }
          } catch (error) {
            markWorkerUnavailable(params.sessionId, worker.workerId)
            workerSupervisor.killSession(
              params.sessionId,
              `worker cancel request failed for session ${params.sessionId}`,
            )
            workerResponse = {
              id: '',
              ok: false as const,
              error: workerError(error),
            }
            cancelledRunIds.push(
              ...(await cancelWorkerOwnedRuns(
                params.sessionId,
                workerOwnedRunIds,
                worker.workerId,
                reason,
              )),
            )
          }
        } else {
          workerResponse = {
            id: '',
            ok: false as const,
            error: {
              type: 'worker' as const,
              message: 'No worker-owned run required cancellation',
              retryable: false,
            },
          }
        }
        scheduleDrain(params.sessionId)
        return { cancelledRunIds, workerResponse }
      },
      snapshot: async params => {
        return buildSnapshot(params.sessionId)
      },
      setModel: async params => {
        return updateSessionSettings(params.sessionId, session => ({
          ...session,
          model: params.model,
          updatedAt: new Date().toISOString(),
        }))
      },
      setMode: async params => {
        return updateSessionSettings(params.sessionId, session => ({
          ...session,
          permissionMode: params.mode,
          updatedAt: new Date().toISOString(),
        }))
      },
    },
    events: {
      replay: params =>
        eventStore
          .replay(params.sessionId, {
            afterSeq: params.afterSeq,
            limit: params.limit,
          })
          .then(events => ({ events })),
      subscribe: (clientId, params) => {
        if (clientId === undefined) return { resultType: 'clientRequired' }
        return options.clientHub.subscribe(
          clientId,
          params.sessionId,
          params.afterSeq,
        )
      },
    },
    approval: {
      respond: async params => respondToApproval(params),
    },
    models: {
      list: async () => ({ models: await listAvailableModelIds() }),
    },
  }

  async function updateSessionSettings(
    sessionId: string,
    updater: (session: SessionRecord) => SessionRecord,
  ): Promise<SessionRecord> {
    const loaded = await ensureSessionRuntimeState(sessionId)
    if (!loaded) throw new Error(`Session not found: ${sessionId}`)

    const activeRun = activeSessionRun(sessionId)
    if (activeRun) {
      throw new Error(
        `Cannot update session settings while run ${activeRun.runId} is ${activeRun.status.type}`,
      )
    }

    const updated = sessionRegistry.update(sessionId, updater)
    if (updated.resultType !== 'updated')
      throw new Error(`Session not found: ${sessionId}`)

    await workerSupervisor.shutdownSession(sessionId, 'restart')
    await appendEvent(sessionId, {
      type: 'session.loaded',
      session: updated.session,
    })
    return updated.session
  }

  async function cancelRunApprovals(runId: string): Promise<void> {
    for (const cancelled of approvalBroker.cancelByRun(runId)) {
      await appendEvent(
        cancelled.approval.sessionId,
        { type: 'approval.resolved', approval: cancelled.approval },
        {
          runId: cancelled.approval.runId,
          workerId: cancelled.approval.workerId,
        },
      )
    }
  }

  async function cancelSessionApprovals(sessionId: string): Promise<void> {
    const runIds = nonTerminalSessionRuns(sessionId).map(run => run.runId)
    for (const runId of runIds) {
      await cancelRunApprovals(runId)
    }
  }

  async function cancelSessionRuns(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    for (const run of nonTerminalSessionRuns(sessionId)) {
      const cancelled = runCoordinator.cancel(run.runId, reason)
      if (cancelled.resultType !== 'updated') continue
      if (cancelled.run.status.type !== 'cancelled') continue
      await appendEvent(
        sessionId,
        { type: 'run.cancelled', runId: run.runId, reason },
        { runId: run.runId },
      )
    }
  }

  function nonTerminalSessionRuns(sessionId: string): RunRecord[] {
    return runCoordinator
      .listRuns(sessionId)
      .filter(run => isNonTerminalRunStatus(run.status.type))
  }

  function activeSessionRun(sessionId: string): RunRecord | undefined {
    return runCoordinator
      .listRuns(sessionId)
      .find(run => isActiveRunStatus(run.status.type))
  }

  function hasQueuedSessionRun(sessionId: string): boolean {
    return nextQueuedSessionRun(sessionId) !== undefined
  }

  function nextQueuedSessionRun(sessionId: string): RunRecord | undefined {
    return runCoordinator
      .listRuns(sessionId)
      .find(run => run.status.type === 'queued')
  }

  async function respondToApproval(
    params: ApprovalRespondParams,
  ): Promise<unknown> {
    const prepared = approvalBroker.prepareResponse(params)
    if (prepared.resultType === 'approvalNotFound') {
      throw new Error(`Approval not found: ${params.approvalId}`)
    }
    if (prepared.resultType === 'sessionMismatch') {
      throw new Error(
        `Approval ${params.approvalId} does not belong to session ${params.sessionId}`,
      )
    }
    if (prepared.resultType === 'invalidOption') {
      throw new Error(`Invalid approval option: ${params.optionId}`)
    }

    if (prepared.resultType === 'alreadyResolved') {
      return prepared
    }

    const response = await workerSupervisor.send(params.sessionId, {
      id: crypto.randomUUID(),
      type: 'approval.response',
      approvalId: params.approvalId,
      decision: prepared.decision,
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }

    const result = approvalBroker.commitResponse(prepared)
    await appendEvent(
      params.sessionId,
      { type: 'approval.resolved', approval: result.approval },
      { runId: result.approval.runId, workerId: result.approval.workerId },
    )
    return result
  }

  async function buildSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await loadSessionForRead(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const existing = await snapshotStore.readLatest(sessionId)
    if (existing && existing.session.updatedAt === session.updatedAt) {
      return existing
    }

    const events = await eventStore.replay(sessionId)
    const snapshot = buildSessionSnapshot(session, events)
    if (snapshot.version > 0) {
      await snapshotStore.writeLatest(sessionId, snapshot)
    }
    return snapshot
  }

  return {
    ports,
    workerSupervisor,
    shutdown: () => workerSupervisor.shutdownAll('serverShutdown'),
  }
}

export function runAppServer(
  argv = process.argv.slice(2),
  env = process.env,
): AppServerRuntime {
  const parsedConfig = parseAppServerConfig(argv, env)
  if (parsedConfig.resultType === 'invalid') {
    throw new Error(parsedConfig.message)
  }

  const serverVersion = env.npm_package_version ?? MACRO.VERSION ?? '0.0.0'
  const runtime = createAppServerRuntime({
    config: parsedConfig.config,
    createServices: context =>
      createDefaultAppServerServices({
        config: parsedConfig.config,
        clientHub: context.clientHub,
        serverVersion,
        sessionHistoryStore: createMatchaAgentSessionHistoryStore(),
      }),
    serverVersion,
  })
  runtime.start()
  registerAppServerShutdownTriggers(runtime)
  return runtime
}

function registerAppServerShutdownTriggers(runtime: AppServerRuntime): void {
  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    shutdownPromise ??= runtime.stop(true)
    void shutdownPromise.finally(() => {
      process.exitCode = 0
    })
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdin.once('end', shutdown)
}

async function updateSnapshotAfterEnvelope(
  snapshotStore: SnapshotStore,
  sessionRegistry: SessionRegistry,
  envelope: AppServerEventEnvelope,
): Promise<void> {
  const existing = await snapshotStore.readLatest(envelope.sessionId)
  const envelopeSession = sessionFromEnvelope(envelope)
  const loaded = sessionRegistry.load(envelope.sessionId)
  const loadedSession =
    envelopeSession ??
    (loaded.resultType === 'loaded' ? loaded.session : undefined)
  const baseSnapshot = existing
    ? loadedSession
      ? { ...existing, session: loadedSession }
      : existing
    : loadedSession
      ? buildSessionSnapshot(loadedSession, [])
      : undefined
  const updated = reduceSessionSnapshot(baseSnapshot, envelope)
  if (updated) {
    await snapshotStore.writeLatest(envelope.sessionId, updated)
  }
}

function updateSessionAfterEnvelope(
  registry: SessionRegistry,
  envelope: AppServerEventEnvelope,
): SessionRecord | undefined {
  if (envelope.event.type === 'session.closed') return undefined

  const session = sessionFromEnvelope(envelope)
  if (session) {
    const existing = registry.load(envelope.sessionId)
    const hasConversation =
      session.hasConversation ||
      (existing.resultType === 'loaded' && existing.session.hasConversation)
    return registry.upsert({
      ...session,
      ...(hasConversation ? { hasConversation: true } : {}),
      lastSeq: envelope.seq,
      lastSnapshotVersion: envelope.seq,
      updatedAt: envelope.createdAt,
    })
  }

  const updated = registry.update(envelope.sessionId, existing => ({
    ...existing,
    ...(envelope.event.type === 'run.queued' ? { hasConversation: true } : {}),
    lastSeq: envelope.seq,
    lastSnapshotVersion: envelope.seq,
    updatedAt: envelope.createdAt,
  }))
  return updated.resultType === 'updated' ? updated.session : undefined
}

function updateSessionWorkerReadyState(
  registry: SessionRegistry,
  supervisor: WorkerSupervisor,
  sessionId: string,
  workerId: string,
): void {
  const worker = supervisor.getWorker(sessionId)
  if (!worker || worker.workerId !== workerId || worker.pid === undefined)
    return

  registry.updateWorkerState(sessionId, {
    state: 'ready',
    workerId,
    pid: worker.pid,
    lastHeartbeatAt: new Date().toISOString(),
  })
}

function updateWorkerHeartbeat(
  registry: SessionRegistry,
  sessionId: string,
  workerId: string,
): void {
  const loaded = registry.load(sessionId)
  if (loaded.resultType !== 'loaded') return

  const workerState = loaded.session.workerState
  const nextWorkerState = refreshWorkerHeartbeat(workerState, workerId)
  if (!nextWorkerState) return

  registry.updateWorkerState(sessionId, nextWorkerState)
}

function refreshWorkerHeartbeat(
  workerState: WorkerRuntimeState,
  workerId: string,
): WorkerRuntimeState | undefined {
  switch (workerState.state) {
    case 'spawning':
    case 'ready':
    case 'running':
    case 'waitingForApproval':
    case 'stopping':
    case 'crashed':
      if (workerState.workerId !== workerId) return undefined
      break
    case 'unloaded':
      return undefined
  }

  if (workerState.state === 'ready') {
    return {
      ...workerState,
      lastHeartbeatAt: new Date().toISOString(),
    }
  }

  return workerState
}

function recoveredWorkerState(
  workerState: WorkerRuntimeState,
): WorkerRuntimeState {
  switch (workerState.state) {
    case 'spawning':
    case 'ready':
    case 'running':
    case 'waitingForApproval':
    case 'stopping':
    case 'crashed':
      return {
        state: 'unloaded',
        reason: 'notStarted',
      }
    case 'unloaded':
      return workerState
  }
}

function invalidApprovalRequestError(runId: string): ClassifiedError {
  return {
    type: 'worker',
    message: `Worker requested approval for inactive run ${runId}`,
    retryable: false,
  }
}

function isActiveRunStatus(statusType: RunRecord['status']['type']): boolean {
  return statusType === 'running' || statusType === 'waitingForApproval'
}

function isNonTerminalRunStatus(
  statusType: RunRecord['status']['type'],
): boolean {
  return (
    statusType === 'queued' ||
    statusType === 'running' ||
    statusType === 'waitingForApproval'
  )
}

async function listAvailableModelIds(): Promise<string[]> {
  const [{ getMainLoopModel }, { getModelOptions }] = await Promise.all([
    import('../utils/model/model.js'),
    import('../utils/model/modelOptions.js'),
  ])
  const modelIds = new Set<string>()
  modelIds.add(getMainLoopModel())

  for (const option of getModelOptions()) {
    if (option.value !== null) {
      modelIds.add(option.value)
    }
  }

  return Array.from(modelIds)
}

function createEmptySessionHistoryStore(): AppServerSessionHistoryStore {
  return {
    list: async () => [],
    load: async () => null,
    transcript: async () => ({ lines: [] }),
  }
}

function createMatchaAgentSessionHistoryStore(): AppServerSessionHistoryStore {
  return {
    list: () => listSessionHistorySummaries(SESSION_HISTORY_LIST_LIMIT),
    load: sessionId => loadSessionHistorySummary(sessionId),
    transcript: async sessionId => ({
      lines: await readSessionTranscriptReplayLines(
        sessionId,
        SESSION_TRANSCRIPT_MAX_LINES,
      ),
    }),
  }
}

function mergeSessionRecords(
  runtimeSessions: SessionRecord[],
  historySessions: SessionRecord[],
): SessionRecord[] {
  const sessionsById = new Map<string, SessionRecord>()
  for (const session of historySessions) {
    sessionsById.set(session.sessionId, session)
  }
  for (const session of runtimeSessions) {
    sessionsById.set(session.sessionId, session)
  }
  return Array.from(sessionsById.values()).sort((left, right) => {
    const updatedCompare = right.updatedAt.localeCompare(left.updatedAt)
    if (updatedCompare !== 0) return updatedCompare
    return left.sessionId.localeCompare(right.sessionId)
  })
}

function historySessionRecord(summary: SessionHistorySummary): SessionRecord {
  return {
    sessionId: summary.sessionId,
    workspaceRoot: summary.workspaceRoot,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.title ? { title: summary.title } : {}),
    runtime: 'matcha-agent',
    transcriptRef: summary.sessionId,
    ...(summary.hasConversation ? { hasConversation: true } : {}),
    lastSeq: 0,
    lastSnapshotVersion: 0,
    workerState: { state: 'unloaded', reason: 'notStarted' },
  }
}

function sessionFromEnvelope(
  envelope: AppServerEventEnvelope,
): SessionRecord | undefined {
  switch (envelope.event.type) {
    case 'session.created':
    case 'session.loaded':
      return envelope.event.session
    default:
      return undefined
  }
}

function isBrokerOwnedWorkerEvent(event: AppServerEvent): boolean {
  return (
    event.type === 'approval.requested' || event.type === 'approval.resolved'
  )
}

function sessionCreateErrorMessage(
  result: Exclude<
    Awaited<ReturnType<SessionRegistry['create']>>,
    { resultType: 'created' }
  >,
): string {
  switch (result.resultType) {
    case 'sessionAlreadyExists':
      return `Session already exists: ${result.sessionId}`
    case 'workspaceUnavailable':
      return `Workspace unavailable: ${result.resolvedPath}: ${result.message}`
  }
}

function reportSessionEventPostAppendFailure(
  stage: SessionEventPostAppendStage,
  _envelope: AppServerEventEnvelope,
  error: unknown,
): void {
  console.error(
    `[app-server:session-event-post-append] stage=${stage} error=${
      error instanceof Error ? 'error' : 'non_error'
    }`,
  )
}

function logAppServerError(scope: string, error: unknown): void {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`[app-server:${scope}] ${message}`)
}
