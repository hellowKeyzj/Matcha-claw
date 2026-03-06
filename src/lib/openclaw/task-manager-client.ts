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

type RpcResult<T> = { success: boolean; result?: T; error?: string };

export type TaskNotification =
  | { method: 'task_progress_update'; params: { taskId: string; progress: number; status: TaskStatus; task?: Task } }
  | { method: 'task_status_changed'; params: { taskId: string; from?: TaskStatus | null; to: TaskStatus; reason?: string; task?: Task } }
  | { method: 'task_blocked'; params: { taskId: string; type: 'waiting_for_input' | 'waiting_approval'; confirmId?: string; inputMode?: 'decision' | 'free_text'; question?: string; description?: string; expiresAt?: number; task?: Task } }
  | { method: 'task_needs_resume'; params: { taskId: string; confirmId?: string; resumeReason: string; decision?: 'approve' | 'reject'; userInput?: string; task?: Task } };

async function gatewayRpc<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as RpcResult<T>;
  if (!response.success) {
    throw new Error(response.error || `RPC failed: ${method}`);
  }
  return response.result as T;
}

export async function getWorkspaceDir(): Promise<string | null> {
  return window.electron.ipcRenderer.invoke('openclaw:getWorkspaceDir') as Promise<string | null>;
}

export async function getTaskWorkspaceDirs(): Promise<string[]> {
  const dirs = await window.electron.ipcRenderer.invoke('openclaw:getTaskWorkspaceDirs') as string[] | null | undefined;
  if (!Array.isArray(dirs)) {
    return [];
  }
  return dirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0);
}

export async function listTasks(workspaceDir?: string): Promise<Task[]> {
  const result = await gatewayRpc<{ tasks?: Task[] } | Task[]>('task_list', workspaceDir ? { workspaceDir } : {});
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(result.tasks) ? result.tasks : [];
}

export async function getTask(taskId: string, workspaceDir?: string): Promise<Task | null> {
  const result = await gatewayRpc<{ task?: Task | null }>('task_get', {
    taskId,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  return result.task ?? null;
}

export async function resumeTask(
  taskId: string,
  options?: { confirmId?: string; decision?: 'approve' | 'reject'; userInput?: string; workspaceDir?: string },
): Promise<Task> {
  const result = await gatewayRpc<{ task: Task }>('task_resume', {
    taskId,
    ...(typeof options?.confirmId === 'string' && options.confirmId.trim().length > 0 ? { confirmId: options.confirmId.trim() } : {}),
    ...(typeof options?.decision === 'string' ? { decision: options.decision } : {}),
    ...(typeof options?.userInput === 'string' ? { userInput: options.userInput } : {}),
    ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  });
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
    idempotencyKey: `task-resume:${target.agentId}:${taskId}:${crypto.randomUUID()}`,
  });
}

export async function getTaskPluginStatus(): Promise<{
  installed: boolean;
  enabled: boolean;
  skillEnabled: boolean;
  version?: string;
  pluginDir: string;
}> {
  return window.electron.ipcRenderer.invoke('task:pluginStatus') as Promise<{
    installed: boolean;
    enabled: boolean;
    skillEnabled: boolean;
    version?: string;
    pluginDir: string;
  }>;
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
  return window.electron.ipcRenderer.invoke('task:pluginInstall') as Promise<{
    success: boolean;
    installed?: boolean;
    enabled?: boolean;
    skillEnabled?: boolean;
    installedPath?: string;
    version?: string;
    error?: string;
  }>;
}
