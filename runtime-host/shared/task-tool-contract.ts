export const TASK_SNAPSHOT_TOOL_METHODS = [
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
  'TodoGet',
] as const;

export type TaskSnapshotToolMethod = typeof TASK_SNAPSHOT_TOOL_METHODS[number];

const TASK_SNAPSHOT_TOOL_METHOD_SET = new Set<string>(TASK_SNAPSHOT_TOOL_METHODS);

const STATE_ONLY_TASK_TOOL_NAMES = {
  todowrite: 'TodoWrite',
  todoget: 'TodoGet',
} as const;

export type StateOnlyTaskToolName = typeof STATE_ONLY_TASK_TOOL_NAMES[keyof typeof STATE_ONLY_TASK_TOOL_NAMES];

export function normalizeToolName(toolName: unknown): string {
  return typeof toolName === 'string' ? toolName.trim() : '';
}

export function canonicalizeStateOnlyTaskToolName(toolName: unknown): StateOnlyTaskToolName | '' {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return '';
  }
  return STATE_ONLY_TASK_TOOL_NAMES[normalized.toLowerCase() as keyof typeof STATE_ONLY_TASK_TOOL_NAMES] ?? '';
}

export function canonicalizeTaskSnapshotToolName(toolName: unknown): TaskSnapshotToolMethod | '' {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return '';
  }
  const stateOnlyName = canonicalizeStateOnlyTaskToolName(normalized);
  if (stateOnlyName) {
    return stateOnlyName;
  }
  return TASK_SNAPSHOT_TOOL_METHOD_SET.has(normalized) ? normalized as TaskSnapshotToolMethod : '';
}

export function isTaskSnapshotToolMethod(toolName: unknown): toolName is TaskSnapshotToolMethod {
  return Boolean(canonicalizeTaskSnapshotToolName(toolName));
}

export function isStateOnlyTaskToolName(toolName: unknown): boolean {
  return Boolean(canonicalizeStateOnlyTaskToolName(toolName));
}

export function isTodoTaskToolName(toolName: unknown): boolean {
  return isStateOnlyTaskToolName(toolName);
}

export function isStateOnlyTaskToolCallSnapshotName(toolName: unknown): boolean {
  return canonicalizeStateOnlyTaskToolName(toolName) === 'TodoWrite';
}
