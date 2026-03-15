import { invokeIpc } from '@/lib/api-client';

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
  input_mode?: 'decision' | 'free_text';
  question?: string;
  description?: string;
  webhook_token?: string;
  expires_at?: number;
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  progress: number;
  plan_markdown: string;
  assigned_session?: string;
  blocked_info?: TaskBlockedInfo;
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
        task?: Task;
      };
    };

type RpcResult<T> = { success: boolean; result?: T; error?: string };

const TASK_RPC_TIMEOUT_MS = 60_000;

function resolveRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function gatewayRpc<T>(method: string, params?: unknown, timeoutMs = TASK_RPC_TIMEOUT_MS): Promise<T> {
  const response = await invokeIpc<RpcResult<T>>('gateway:rpc', method, params, timeoutMs);
  if (!response.success) {
    throw new Error(response.error || `RPC failed: ${method}`);
  }
  return response.result as T;
}

export async function getWorkspaceDir(): Promise<string | null> {
  const value = await invokeIpc<unknown>('openclaw:getWorkspaceDir');
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export async function getTaskWorkspaceDirs(): Promise<string[]> {
  const value = await invokeIpc<unknown>('openclaw:getTaskWorkspaceDirs');
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

function parseAgentIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function resolveResumeTarget(assignedSession?: string): { agentId: string; sessionKey: string } {
  const agentId = parseAgentIdFromSessionKey(assignedSession) ?? 'main';
  return {
    agentId,
    sessionKey: `agent:${agentId}:main`,
  };
}

export async function wakeTaskSession(taskId: string, options?: { message?: string; assignedSession?: string }): Promise<void> {
  const target = resolveResumeTarget(options?.assignedSession);
  await gatewayRpc('agent', {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    message: `请恢复执行任务 ${taskId}${options?.message ? `。附加信息：${options.message}` : ''}`,
    idempotencyKey: `task-resume:${target.agentId}:${taskId}:${resolveRandomId()}`,
  });
}

export async function getTaskPluginStatus(): Promise<{
  installed: boolean;
  enabled: boolean;
  skillEnabled: boolean;
  version?: string;
  pluginDir: string;
}> {
  return invokeIpc('task:pluginStatus');
}

export async function installTaskPlugin(): Promise<{
  success: boolean;
  installed?: boolean;
  enabled?: boolean;
  skillEnabled?: boolean;
  installedPath?: string;
  version?: string;
  error?: string;
}> {
  return invokeIpc('task:pluginInstall');
}

export async function uninstallTaskPlugin(): Promise<{
  success: boolean;
  installed?: boolean;
  enabled?: boolean;
  skillEnabled?: boolean;
  removedPath?: string;
  error?: string;
}> {
  return invokeIpc('task:pluginUninstall');
}
