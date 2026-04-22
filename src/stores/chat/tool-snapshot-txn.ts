import { hasAssistantToolCall } from './message-helpers';
import type { RawMessage } from './types';

type ToolSnapshotTxnState =
  | { phase: 'idle' }
  | {
    phase: 'armed';
    sessionKey: string;
    runId: string;
    snapshotMessage: RawMessage;
  };

let toolSnapshotTxnState: ToolSnapshotTxnState = { phase: 'idle' };

export function getToolSnapshotTxnPhase(): ToolSnapshotTxnState['phase'] {
  return toolSnapshotTxnState.phase;
}

export function resetToolSnapshotTxnState(): void {
  toolSnapshotTxnState = { phase: 'idle' };
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
    snapshotMessage: normalizedMessage,
  };
}

export function consumeToolSnapshotTxnState(
  sessionKey: string,
  runId: string,
): RawMessage | null {
  if (toolSnapshotTxnState.phase !== 'armed') {
    return null;
  }
  const armed = toolSnapshotTxnState;
  const sameSession = armed.sessionKey === sessionKey;
  const normalizedRunId = runId.trim();
  const sameRun = (
    !armed.runId
    || !normalizedRunId
    || armed.runId === normalizedRunId
  );
  const canCommit = sameSession && sameRun;
  const snapshotMessage = canCommit ? armed.snapshotMessage : null;
  resetToolSnapshotTxnState();
  return snapshotMessage;
}
