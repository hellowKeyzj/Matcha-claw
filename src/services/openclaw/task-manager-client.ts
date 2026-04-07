import {
  hostOpenClawGetTaskWorkspaceDirs,
  hostOpenClawGetWorkspaceDir,
  hostGatewayRpc,
} from '@/lib/host-api';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_approval'
  | 'completed'
  | 'failed';

export interface TaskBlockedInfo {
  reason: 'need_user_confirm' | 'waiting_external_approval';
  confirm_id?: string;
  grace_until?: number;
  input_mode?: 'decision' | 'free_text';
  question?: string;
  description?: string;
  webhook_token?: string;
  expires_at?: number;
}

export type TaskStepStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed';

export interface TaskStep {
  id: string;
  title: string;
  description?: string;
  depends_on: string[];
  status: TaskStepStatus;
  created_at: number;
  updated_at: number;
  started_at?: number;
  finished_at?: number;
}

export type TaskCheckpointKind = 'checkpoint' | 'block' | 'resume' | 'finish';

export interface TaskCheckpoint {
  id: string;
  kind: TaskCheckpointKind;
  summary: string;
  created_at: number;
  payload?: Record<string, unknown>;
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  progress: number;
  steps: TaskStep[];
  current_step_id?: string;
  checkpoints: TaskCheckpoint[];
  assigned_session?: string;
  blocked_info?: TaskBlockedInfo;
  result_summary?: string;
  failure_reason?: string;
  finished_at?: number;
  created_at: number;
  updated_at: number;
  workspaceDir?: string;
}

export type TaskNotification =
  | {
      method: 'task_progress_update';
      params: { taskId: string; progress: number; status: TaskStatus; task?: Task };
    }
  | {
      method: 'task_status_changed';
      params: { taskId: string; from?: TaskStatus | null; to: TaskStatus; reason?: string; task?: Task };
    }
  | {
      method: 'task_blocked';
      params: {
        taskId: string;
        type: 'waiting_for_input' | 'waiting_approval';
        confirmId?: string;
        inputMode?: 'decision' | 'free_text';
        question?: string;
        description?: string;
        expiresAt?: number;
        graceUntil?: number;
        task?: Task;
      };
    }
  | {
      method: 'task_needs_resume';
      params: {
        taskId: string;
        confirmId?: string;
        resumeReason: string;
        decision?: 'approve' | 'reject';
        userInput?: string;
        resumePacket?: Record<string, unknown>;
        task?: Task;
      };
    }
  | {
      method: 'task_deleted';
      params: {
        taskId: string;
        reason?: string;
        task?: Task;
      };
    };

const TASK_RPC_TIMEOUT_MS = 60_000;

function resolveRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function gatewayRpc<T>(method: string, params?: unknown, timeoutMs = TASK_RPC_TIMEOUT_MS): Promise<T> {
  return await hostGatewayRpc<T>(method, params, timeoutMs);
}

export async function getWorkspaceDir(): Promise<string | null> {
  const value = await hostOpenClawGetWorkspaceDir();
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export async function getTaskWorkspaceDirs(): Promise<string[]> {
  const value = await hostOpenClawGetTaskWorkspaceDirs();
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export async function listTasks(workspaceDir?: string): Promise<Task[]> {
  const result = await gatewayRpc<{ tasks?: Task[] } | Task[]>('task_list', workspaceDir ? { workspaceDir } : {}, TASK_RPC_TIMEOUT_MS);
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(result.tasks) ? result.tasks : [];
}

export async function getTask(taskId: string, workspaceDir?: string): Promise<Task | null> {
  const result = await gatewayRpc<{ task?: Task | null }>(
    'task_get',
    {
      taskId,
      ...(workspaceDir ? { workspaceDir } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  return result.task ?? null;
}

export async function resumeTask(
  taskId: string,
  options?: { confirmId?: string; decision?: 'approve' | 'reject'; userInput?: string; workspaceDir?: string },
): Promise<Task> {
  const result = await gatewayRpc<{ task: Task }>(
    'task_resume',
    {
      taskId,
      ...(typeof options?.confirmId === 'string' && options.confirmId.trim().length > 0
        ? { confirmId: options.confirmId.trim() }
        : {}),
      ...(typeof options?.decision === 'string' ? { decision: options.decision } : {}),
      ...(typeof options?.userInput === 'string' ? { userInput: options.userInput } : {}),
      ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  return result.task;
}

export async function deleteTask(
  taskId: string,
  options?: { workspaceDir?: string; reason?: string },
): Promise<{ deleted: boolean; taskId: string }> {
  return gatewayRpc<{ deleted: boolean; taskId: string }>(
    'task_delete',
    {
      taskId,
      ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      ...(typeof options?.reason === 'string' && options.reason.trim().length > 0
        ? { reason: options.reason.trim() }
        : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function resolveResumeTarget(assignedSession?: string): { agentId: string; sessionKey: string } {
  const normalizedAssigned = typeof assignedSession === 'string' ? assignedSession.trim() : '';
  const agentId = parseAgentIdFromSessionKey(normalizedAssigned) ?? 'main';
  return {
    agentId,
    sessionKey: normalizedAssigned || `agent:${agentId}:main`,
  };
}

function buildWakeTaskMessage(
  taskId: string,
  options?: {
    message?: string;
    task?: Task;
  },
): string {
  const lines: string[] = [`请恢复执行任务 ${taskId}。`];
  const task = options?.task;
  if (task) {
    lines.push(`任务目标：${task.goal}`);
    lines.push(`任务状态：${task.status}（progress=${task.progress}）`);
    const currentStep = task.steps.find((step) => step.id === task.current_step_id);
    if (currentStep) {
      lines.push(`当前步骤：${currentStep.title}`);
      if (currentStep.description) {
        lines.push(`步骤说明：${currentStep.description}`);
      }
    }
    if (task.workspaceDir) {
      lines.push(`任务文件路径：${task.workspaceDir}\\.task-manager\\tasks.json`);
    }
  }
  if (options?.message) {
    lines.push(`附加信息：${options.message}`);
  }
  lines.push('请优先依据任务上下文推进，不要假设任务目录是 .tasks。');
  return lines.join('\n');
}

export async function wakeTaskSession(
  taskId: string,
  options?: { message?: string; assignedSession?: string; task?: Task },
): Promise<void> {
  const target = resolveResumeTarget(options?.assignedSession);
  await gatewayRpc('agent', {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    message: buildWakeTaskMessage(taskId, options),
    idempotencyKey: `task-resume:${target.agentId}:${taskId}:${resolveRandomId()}`,
  });
}
