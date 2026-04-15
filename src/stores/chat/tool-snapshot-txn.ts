import { getMessageText, hasAssistantToolCall } from './message-helpers';
import type { RawMessage } from './types';

type ToolSnapshotTxnState =
  | { phase: 'idle' }
  | {
    phase: 'armed';
    sessionKey: string;
    runId: string;
    streamKey: string;
  };

let toolSnapshotTxnState: ToolSnapshotTxnState = { phase: 'idle' };

export function getToolSnapshotTxnPhase(): ToolSnapshotTxnState['phase'] {
  return toolSnapshotTxnState.phase;
}

export function resetToolSnapshotTxnState(): void {
  toolSnapshotTxnState = { phase: 'idle' };
}

function resolveAssistantToolStreamKey(message: RawMessage | null | undefined): string {
  if (!message) {
    return '';
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const toolBlockIds = (blocks as Array<Record<string, unknown>>)
    .filter((block) => (
      block
      && typeof block === 'object'
      && (block.type === 'tool_use' || block.type === 'toolCall')
    ))
    .map((block) => (typeof block.id === 'string' ? block.id : ''))
    .filter(Boolean)
    .join(',');
  if (typeof message.id === 'string' && message.id.trim()) {
    return `${message.id}|${toolBlockIds}`;
  }
  return `assistant|${toolBlockIds}|${getMessageText(message.content).trim().slice(0, 120)}`;
}

export function armToolSnapshotTxnState(
  sessionKey: string,
  runId: string,
  message: unknown,
): void {
  const normalizedMessage = (message && typeof message === 'object') ? message as RawMessage : null;
  if (!normalizedMessage) {
    return;
  }
  const role = typeof normalizedMessage.role === 'string' ? normalizedMessage.role : 'assistant';
  if (role !== 'assistant' || !hasAssistantToolCall(normalizedMessage)) {
    return;
  }
  toolSnapshotTxnState = {
    phase: 'armed',
    sessionKey,
    runId: runId.trim(),
    streamKey: resolveAssistantToolStreamKey(normalizedMessage),
  };
}

export function consumeToolSnapshotTxnState(
  sessionKey: string,
  runId: string,
  currentStream: RawMessage | null,
): boolean {
  if (toolSnapshotTxnState.phase !== 'armed') {
    return false;
  }
  const armed = toolSnapshotTxnState;
  const sameSession = armed.sessionKey === sessionKey;
  const normalizedRunId = runId.trim();
  const sameRun = (
    !armed.runId
    || !normalizedRunId
    || armed.runId === normalizedRunId
  );
  const hasToolCall = hasAssistantToolCall(currentStream ?? undefined);
  const streamKeyMatches = currentStream
    ? resolveAssistantToolStreamKey(currentStream) === armed.streamKey
    : false;
  const canCommit = sameSession && sameRun && hasToolCall && streamKeyMatches;
  resetToolSnapshotTxnState();
  return canCommit;
}
