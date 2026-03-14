import type { TeamMailboxKind, TeamMailboxMessage, TeamTaskRecord, TeamTaskStatus } from './types';

const TASK_TRANSITIONS: Record<TeamTaskStatus, TeamTaskStatus[]> = {
  todo: ['claimed'],
  claimed: ['running', 'todo'],
  running: ['done', 'blocked', 'failed'],
  blocked: ['running', 'failed', 'todo'],
  done: [],
  failed: ['todo', 'claimed'],
};

const MAILBOX_KINDS: TeamMailboxKind[] = ['question', 'proposal', 'decision', 'report'];

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0);
}

function toTitleFromInstruction(instruction: string): string {
  const first = instruction.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return first.slice(0, 120) || 'Untitled Task';
}

export function isTaskStatusTransitionAllowed(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) {
    return true;
  }
  return TASK_TRANSITIONS[from].includes(to);
}

export function sanitizeTaskRecord(
  input: Partial<TeamTaskRecord> & { taskId: string; instruction: string },
  nowMs = Date.now(),
): TeamTaskRecord {
  const taskId = normalizeText(input.taskId);
  const instruction = normalizeText(input.instruction);
  if (!taskId) {
    throw new Error('taskId is required');
  }
  if (!instruction) {
    throw new Error('instruction is required');
  }

  const status = (input.status ?? 'todo') as TeamTaskStatus;
  const dependsOn = normalizeStringArray(input.dependsOn);
  const title = normalizeText(input.title) || toTitleFromInstruction(instruction);
  const attempt = Number.isFinite(input.attempt) ? Math.max(0, Number(input.attempt)) : 0;

  return {
    taskId,
    title,
    instruction,
    dependsOn,
    status,
    ownerAgentId: normalizeText(input.ownerAgentId) || undefined,
    claimSessionKey: normalizeText(input.claimSessionKey) || undefined,
    claimedAt: typeof input.claimedAt === 'number' ? input.claimedAt : undefined,
    leaseUntil: typeof input.leaseUntil === 'number' ? input.leaseUntil : undefined,
    attempt,
    resultSummary: normalizeText(input.resultSummary) || undefined,
    error: normalizeText(input.error) || undefined,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : nowMs,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : nowMs,
  };
}

export function sanitizeMailboxMessage(
  input: Partial<TeamMailboxMessage> & { msgId: string; fromAgentId: string; content: string },
  nowMs = Date.now(),
): TeamMailboxMessage {
  const msgId = normalizeText(input.msgId);
  const fromAgentId = normalizeText(input.fromAgentId);
  const content = normalizeText(input.content);
  if (!msgId) throw new Error('msgId is required');
  if (!fromAgentId) throw new Error('fromAgentId is required');
  if (!content) throw new Error('content is required');

  const to = normalizeText(input.to) || 'broadcast';
  const kind = MAILBOX_KINDS.includes((input.kind ?? 'question') as TeamMailboxKind)
    ? (input.kind ?? 'question')
    : 'question';

  return {
    msgId,
    fromAgentId,
    to,
    kind,
    content,
    relatedTaskId: normalizeText(input.relatedTaskId) || undefined,
    replyToMsgId: normalizeText(input.replyToMsgId) || undefined,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : nowMs,
  };
}
