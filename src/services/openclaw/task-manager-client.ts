import {
  hostOpenClawGetTaskWorkspaceDirs,
  hostOpenClawGetWorkspaceDir,
  hostGatewayRpc,
} from '@/lib/host-api';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  activeForm?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  workspaceDir?: string;
  // Frontend-local session affinity for quick reopen/navigation.
  sessionAffinityKey?: string;
}

const TASK_RPC_TIMEOUT_MS = 60_000;

async function gatewayRpc<T>(method: string, params?: unknown, timeoutMs = TASK_RPC_TIMEOUT_MS): Promise<T> {
  return await hostGatewayRpc<T>(method, params, timeoutMs);
}

function normalizeStatus(raw: unknown): TaskStatus {
  if (raw === 'in_progress' || raw === 'completed') {
    return raw;
  }
  return 'pending';
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string');
}

function normalizeTask(raw: unknown, workspaceDir?: string): Task {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const subject = typeof row.subject === 'string' && row.subject.trim().length > 0
    ? row.subject.trim()
    : 'Untitled task';
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : createdAt;

  return {
    id: typeof row.id === 'string' ? row.id : '',
    subject,
    description: typeof row.description === 'string' ? row.description : '',
    status: normalizeStatus(row.status),
    ...(typeof row.owner === 'string' && row.owner.trim().length > 0 ? { owner: row.owner.trim() } : {}),
    blockedBy: normalizeStringArray(row.blockedBy),
    blocks: normalizeStringArray(row.blocks),
    ...(typeof row.activeForm === 'string' && row.activeForm.trim().length > 0 ? { activeForm: row.activeForm.trim() } : {}),
    ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
    createdAt,
    updatedAt,
    ...(workspaceDir ? { workspaceDir } : {}),
  };
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

export async function listTasks(workspaceDir?: string, taskListId?: string): Promise<Task[]> {
  const result = await gatewayRpc<{ tasks?: unknown[] }>(
    'task_manager.list',
    {
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(taskListId ? { taskListId } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  const rows = Array.isArray(result.tasks) ? result.tasks : [];
  return rows.map((row) => normalizeTask(row, workspaceDir));
}

export async function getTask(taskId: string, workspaceDir?: string, taskListId?: string): Promise<Task | null> {
  const result = await gatewayRpc<{ task?: unknown | null }>(
    'task_manager.get',
    {
      taskId,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(taskListId ? { taskListId } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  if (!result.task) {
    return null;
  }
  return normalizeTask(result.task, workspaceDir);
}

export async function createTask(payload: {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  workspaceDir?: string;
  taskListId?: string;
}): Promise<Task> {
  const result = await gatewayRpc<{ task: unknown }>(
    'task_manager.create',
    {
      subject: payload.subject,
      description: payload.description,
      ...(payload.activeForm ? { activeForm: payload.activeForm } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      ...(payload.workspaceDir ? { workspaceDir: payload.workspaceDir } : {}),
      ...(payload.taskListId ? { taskListId: payload.taskListId } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  return normalizeTask(result.task, payload.workspaceDir);
}

export async function updateTask(payload: {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string | null;
  owner?: string | null;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
  workspaceDir?: string;
  taskListId?: string;
}): Promise<{ task: Task; updatedFields: string[]; statusChange?: { from: string; to: string } }> {
  const result = await gatewayRpc<{ task: unknown; updatedFields?: string[]; statusChange?: { from: string; to: string } }>(
    'task_manager.update',
    {
      taskId: payload.taskId,
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.subject ? { subject: payload.subject } : {}),
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.activeForm !== undefined ? { activeForm: payload.activeForm } : {}),
      ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
      ...(payload.addBlockedBy ? { addBlockedBy: payload.addBlockedBy } : {}),
      ...(payload.addBlocks ? { addBlocks: payload.addBlocks } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      ...(payload.workspaceDir ? { workspaceDir: payload.workspaceDir } : {}),
      ...(payload.taskListId ? { taskListId: payload.taskListId } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  return {
    task: normalizeTask(result.task, payload.workspaceDir),
    updatedFields: Array.isArray(result.updatedFields) ? result.updatedFields : [],
    ...(result.statusChange ? { statusChange: result.statusChange } : {}),
  };
}

export async function claimTask(payload: {
  taskId: string;
  owner?: string;
  workspaceDir?: string;
  taskListId?: string;
  sessionKey?: string;
}): Promise<Task> {
  const result = await gatewayRpc<{ task: unknown }>(
    'task_manager.claim',
    {
      taskId: payload.taskId,
      ...(payload.owner ? { owner: payload.owner } : {}),
      ...(payload.workspaceDir ? { workspaceDir: payload.workspaceDir } : {}),
      ...(payload.taskListId ? { taskListId: payload.taskListId } : {}),
      ...(payload.sessionKey ? { sessionKey: payload.sessionKey } : {}),
    },
    TASK_RPC_TIMEOUT_MS,
  );
  return normalizeTask(result.task, payload.workspaceDir);
}
