import {
  createFileJournalStore,
  type ProgressEvent,
  type WorkflowPorts,
} from '@claude-code-best/workflow-engine'
import { logForDebugging } from '../utils/debug.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { getRunsDir } from './persistence.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  killWorkflowTask,
  type LocalWorkflowTaskState,
  registerLocalWorkflowTask,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  buildHostBundle,
  makeHostHandle,
  readHostBundle,
  type WorkflowHostBundle,
} from './hostHandle.js'
import { buildRegistry } from './registry.js'
import type { ProgressBus } from './progress/bus.js'
import type { ProgressStore } from './progress/store.js'
import type { SetAppState } from '../Task.js'
import type { AssistantMessage } from '../types/message.js'
import { updateTaskState } from '../utils/task/framework.js'
import {
  enqueueWorkflowNotification,
  type WorkflowNotificationRun,
} from './notifications.js'

export type HostWorkflowPorts = WorkflowPorts & {
  notifyRun(run: WorkflowNotificationRun): void
}

type RunBinding = {
  runId: string
  taskId: string
  setAppState: SetAppState
  abortController: AbortController
  workflowName: string
  /** agentId → AbortController. Registered when backend starts an agent; killAgent uses it for precise abort. */
  agentAbortControllers: Map<number, AbortController>
}

/** Constructs a WorkflowHostContext from toolUseContext on each tool invocation. */
function makeHostFactory(): WorkflowPorts['hostFactory'] {
  return ({ context, canUseTool, parentMessage }) => {
    const ctx = context as WorkflowHostBundle['toolUseContext'] & {
      agentId?: string
    }
    return {
      handle: makeHostHandle(
        buildHostBundle(
          ctx,
          canUseTool as WorkflowHostBundle['canUseTool'],
          parentMessage as AssistantMessage | undefined,
        ),
      ),
      // Use projectRoot rather than getCwd(): shares the same root as journalStore's runsDir,
      // otherwise named workflow resolution and journal persistence diverge when the user
      // enters a worktree/sub-directory. The engine's internal ctx.cwd is only used for
      // resolution (scriptPath/name) and does not affect the agent's execution cwd
      // (the agent gets its own cwd via the toolUseContext inside the host bundle).
      cwd: getProjectRoot(),
      budgetTotal: null, // turn-level budget injection point (read from settings in the future)
      ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
    }
  }
}

/**
 * Assembles the complete WorkflowPorts. bus/store are passed in by the caller (shared via the service singleton).
 * taskRegistrar maintains runId → RunBinding for kill routing.
 */
export function createWorkflowPorts(opts: {
  bus: ProgressBus
  store: ProgressStore
}): HostWorkflowPorts {
  const bindings = new Map<string, RunBinding>()
  const notifyRun = (binding: RunBinding, run: WorkflowNotificationRun): void => {
    if (run.status === 'running') return
    let notificationTask: LocalWorkflowTaskState | undefined
    updateTaskState<LocalWorkflowTaskState>(
      binding.taskId,
      binding.setAppState,
      task => {
        if (task.notified) return task
        notificationTask = {
          ...task,
          status: task.status === 'killed' ? 'killed' : run.status,
          endTime: task.endTime ?? Date.now(),
          abortController: undefined,
          ...(run.error !== undefined ? { error: run.error } : {}),
        }
        return notificationTask
      },
    )
    if (!notificationTask) return
    enqueueWorkflowNotification(
      {
        ...run,
        status: notificationTask.status === 'killed' ? 'killed' : run.status,
      },
      notificationTask,
    )
    updateTaskState<LocalWorkflowTaskState>(
      binding.taskId,
      binding.setAppState,
      task => ({ ...task, notified: true }),
    )
  }
  const runsDir = getRunsDir()
  const registry = buildRegistry()

  // Telemetry subscription (independent of store). LogEventMetadata only accepts boolean/number/undefined,
  // and runId is a string — use the brand cast provided by the analytics module (verified non-code/path) to pass it through.
  opts.bus.subscribe((e: ProgressEvent) => {
    if (e.type === 'run_done') {
      logEvent('tengu_workflow_done', {
        status: e.status === 'completed' ? 0 : e.status === 'failed' ? 1 : 2,
        runId:
          e.runId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  })

  const taskRegistrar: WorkflowPorts['taskRegistrar'] = {
    register(regOpts, host) {
      const bundle = readHostBundle(host)
      const setAppState =
        bundle.toolUseContext.setAppStateForTasks ??
        bundle.toolUseContext.setAppState
      const abortController = new AbortController()
      const taskId = registerLocalWorkflowTask(setAppState, {
        description: regOpts.summary ?? regOpts.workflowName,
        workflowName: regOpts.workflowName,
        workflowFile: regOpts.workflowFile ?? '',
        summary: regOpts.summary,
        ...(regOpts.toolUseId ? { toolUseId: regOpts.toolUseId } : {}),
        abortController,
      })
      const runId = regOpts.runId ?? taskId
      const binding: RunBinding = {
        runId,
        taskId,
        setAppState,
        abortController,
        workflowName: regOpts.workflowName,
        agentAbortControllers: new Map(),
      }
      bindings.set(runId, binding)
      abortController.signal.addEventListener(
        'abort',
        () => {
          queueMicrotask(() =>
            notifyRun(binding, {
              runId,
              workflowName: binding.workflowName,
              status: 'killed',
            }),
          )
        },
        { once: true },
      )
      logForDebugging(
        `workflow task registered: ${runId} (${regOpts.workflowName})`,
      )
      return { runId, signal: abortController.signal }
    },
    complete(runId, summary, signal) {
      const b = bindings.get(runId)
      if (!b || (signal && b.abortController.signal !== signal)) return
      notifyRun(b, {
        runId,
        workflowName: b.workflowName,
        status: 'completed',
      })
      logForDebugging(`workflow ${runId} completed: ${summary ?? ''}`)
      if (bindings.get(runId) === b) bindings.delete(runId)
    },
    fail(runId, error, signal) {
      const b = bindings.get(runId)
      if (!b || (signal && b.abortController.signal !== signal)) return
      notifyRun(b, {
        runId,
        workflowName: b.workflowName,
        status: 'failed',
        error,
      })
      logForDebugging(`workflow ${runId} failed: ${error}`)
      if (bindings.get(runId) === b) bindings.delete(runId)
    },
    kill(runId, signal) {
      const b = bindings.get(runId)
      if (!b || (signal && b.abortController.signal !== signal)) return
      killWorkflowTask(b.taskId, b.setAppState) // internal abort controller
      // Killing the run also aborts all in-flight agents (guards against the edge timing where the backend misses the task abort)
      for (const ac of b.agentAbortControllers.values()) {
        try {
          ac.abort()
        } catch {
          // no-op: abort won't throw internally, but fail-closed
        }
      }
      b.agentAbortControllers.clear()
      notifyRun(b, { runId, workflowName: b.workflowName, status: 'killed' })
      if (signal && bindings.get(runId) === b) bindings.delete(runId)
    },
    registerAgentAbort(runId, agentId, ac, signal) {
      const b = bindings.get(runId)
      if (!b || (signal && b.abortController.signal !== signal)) return
      b.agentAbortControllers.set(agentId, ac)
    },
    unregisterAgentAbort(runId, agentId, signal) {
      const b = bindings.get(runId)
      if (!b || (signal && b.abortController.signal !== signal)) return
      b.agentAbortControllers.delete(agentId)
    },
    killAgent(runId, agentId) {
      const b = bindings.get(runId)
      if (!b) return false
      const ac = b.agentAbortControllers.get(agentId)
      if (!ac) return false
      try {
        ac.abort()
      } catch {
        // no-op
      }
      b.agentAbortControllers.delete(agentId)
      return true
    },
    pendingAction() {
      return null // v1: skip/retry not wired (seam retained)
    },
  }

  return {
    notifyRun(run) {
      const binding = bindings.get(run.runId)
      if (binding) notifyRun(binding, run)
    },
    hostFactory: makeHostFactory(),
    agentAdapterRegistry: registry,
    agentRunner: {
      // Dead-code fallback: hooks always go through agentAdapterRegistry (required on ports). Reaching here means the registry was not registered — fail-fast.
      async runAgentToResult() {
        throw new Error(
          'workflow agentRunner fallback reached — agentAdapterRegistry must be set on ports',
        )
      },
    },
    progressEmitter: {
      emit(event, signal) {
        if (
          signal &&
          bindings.get(event.runId)?.abortController.signal !== signal
        ) return
        opts.bus.emit(event) // → store reducer + telemetry
      },
    },
    taskRegistrar,
    journalStore: createFileJournalStore(runsDir),
    permissionGate: { isAborted: () => false }, // engine uses ctx.signal to check abort
    logger: {
      debug: msg => logForDebugging(msg),
      warn: msg => logForDebugging(`[workflow warn] ${msg}`),
      event: name => logForDebugging(`workflow event: ${name}`),
    },
  }
}
