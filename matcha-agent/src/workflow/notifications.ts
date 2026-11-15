/**
 * Bridge for workflow status-change notifications.
 *
 * The engine emits events via progressEmitter.emit({ type: 'run_done', ... }),
 * and the progress/store reducer records the status into RunProgress. But the
 * old implementation had no code bridging status transitions to the host
 * notification mechanism — the "notifies automatically on completion" promise
 * in WorkflowTool's return text went unfulfilled.
 *
 * This module subscribes to WorkflowService.subscribe, watches status transitions
 * from running → completed/failed/killed, and emits a host notification via the
 * injected notifier callback; production resolves the registered task before enqueueing.
 */
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import type { TaskStateBase } from '../Task.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import type { RunProgress } from './progress/store.js'
import type { WorkflowService } from './service.js'

const WORKFLOW_TASK_TYPE = 'local_workflow'

/** Notifier abstraction (lets tests inject a spy). */
export type WorkflowNotifier = (message: string, run: RunProgress) => void

const TERMINAL_STATUSES: ReadonlySet<RunProgress['status']> = new Set([
  'completed',
  'failed',
  'killed',
])

export type WorkflowNotificationRun = Pick<
  RunProgress,
  'runId' | 'workflowName' | 'status' | 'error'
>

export function enqueueWorkflowNotification(
  run: WorkflowNotificationRun,
  task: TaskStateBase,
): void {
  if (run.status === 'running') return
  const summary = buildSummary(run)
  emitTaskTerminatedSdk(
    task.id,
    run.status === 'killed' ? 'stopped' : run.status,
    {
      toolUseId: task.toolUseId,
      requestMessageId: task.requestMessageId,
      summary,
    },
  )
  enqueuePendingNotification({
    value: buildMessage(run, task),
    mode: 'task-notification',
    taskNotification: {
      taskId: task.id,
      toolUseId: task.toolUseId,
      requestMessageId: task.requestMessageId,
    },
  })
}

export function installWorkflowNotifications(
  service: WorkflowService,
  notify: WorkflowNotifier,
): () => void {
  const prevStatus = new Map<string, RunProgress['status'] | undefined>()

  const unsubscribe = service.subscribe(() => {
    const runs = service.listRuns()
    for (const run of runs) {
      const prev = prevStatus.get(run.runId)
      // First time seeing this run: just record the current status without notifying
      // (avoids treating existing historical runs as new notifications on install)
      if (prev === undefined) {
        prevStatus.set(run.runId, run.status)
        continue
      }
      // Status changed + entered terminal state → emit notification
      if (prev !== run.status && TERMINAL_STATUSES.has(run.status)) {
        notify(buildMessage(run), run)
      }
      prevStatus.set(run.runId, run.status)
    }
  })

  return () => {
    unsubscribe()
    prevStatus.clear()
  }
}

function buildSummary(run: WorkflowNotificationRun): string {
  const statusText =
    run.status === 'completed'
      ? 'completed successfully'
      : run.status === 'failed'
        ? 'failed'
        : 'was stopped'
  const errorSuffix =
    run.status === 'failed' && run.error ? `: ${run.error}` : ''
  return `Workflow "${run.workflowName}" ${statusText}${errorSuffix}`
}

function buildMessage(
  run: WorkflowNotificationRun,
  task?: TaskStateBase,
): string {
  const identity = task
    ? `<${TASK_ID_TAG}>${task.id}</${TASK_ID_TAG}>${task.toolUseId ? `\n<${TOOL_USE_ID_TAG}>${task.toolUseId}</${TOOL_USE_ID_TAG}>` : ''}\n`
    : ''
  return `<${TASK_NOTIFICATION_TAG}>
${identity}<${TASK_TYPE_TAG}>${WORKFLOW_TASK_TYPE}</${TASK_TYPE_TAG}>
<${STATUS_TAG}>${run.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${buildSummary(run)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}
