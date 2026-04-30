import { reduceSessionRuntime } from './runtime-state-reducer';
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import type {
  ApprovalDecision,
  ApprovalItem,
  ChatStoreState,
} from './types';

export function groupApprovalsBySession(items: ApprovalItem[]): Record<string, ApprovalItem[]> {
  const grouped: Record<string, ApprovalItem[]> = {};
  for (const item of items) {
    if (!grouped[item.sessionKey]) grouped[item.sessionKey] = [];
    grouped[item.sessionKey].push(item);
  }
  for (const [sessionKey, sessionItems] of Object.entries(grouped)) {
    grouped[sessionKey] = [...sessionItems].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  return grouped;
}

interface BuildSyncPendingApprovalsPatchInput {
  state: ChatStoreState;
  grouped: Record<string, ApprovalItem[]>;
  sessionKeyHint?: string;
}

export function buildSyncPendingApprovalsPatch(
  input: BuildSyncPendingApprovalsPatchInput,
): Partial<ChatStoreState> {
  const { state, grouped, sessionKeyHint } = input;
  const normalizedHint = typeof sessionKeyHint === 'string' ? sessionKeyHint.trim() : '';
  const nextApprovals = normalizedHint
    ? { ...state.pendingApprovalsBySession, [normalizedHint]: grouped[normalizedHint] ?? [] }
    : grouped;
  const currentPending = nextApprovals[state.currentSessionKey] ?? [];
  const currentRuntime = getSessionRuntime(state, state.currentSessionKey);
  const nextActiveRunId = currentRuntime.activeRunId ?? currentPending.find((item) => typeof item.runId === 'string')?.runId ?? null;
  const runtimePatch = reduceSessionRuntime(currentRuntime, {
    type: 'pending_approvals_synced',
    currentPendingCount: currentPending.length,
    nextActiveRunId,
  });
  return {
    pendingApprovalsBySession: nextApprovals,
    ...(runtimePatch === currentRuntime
        ? {}
        : {
          loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
            runtime: { ...currentRuntime, ...runtimePatch },
          }),
        }),
  };
}

interface BuildApprovalRequestedPatchInput {
  state: ChatStoreState;
  approval: ApprovalItem;
}

export function buildApprovalRequestedPatch(
  input: BuildApprovalRequestedPatchInput,
): Partial<ChatStoreState> {
  const { state, approval } = input;
  const sessionKey = approval.sessionKey;
  const isCurrentSession = sessionKey === state.currentSessionKey;
  const existing = state.pendingApprovalsBySession[sessionKey] ?? [];
  const filtered = existing.filter((item) => item.id !== approval.id);
  const nextSessionItems = [...filtered, approval].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const nextApprovals = {
    ...state.pendingApprovalsBySession,
    [sessionKey]: nextSessionItems,
  };
  if (!isCurrentSession) {
    return {
      pendingApprovalsBySession: nextApprovals,
    };
  }
  const currentRuntime = getSessionRuntime(state, state.currentSessionKey);
  const runtimePatch = reduceSessionRuntime(currentRuntime, {
    type: 'approval_requested',
    isCurrentSession,
    runId: approval.runId,
  });
  return {
    pendingApprovalsBySession: nextApprovals,
    ...(runtimePatch === currentRuntime
        ? {}
        : {
          loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
            runtime: { ...currentRuntime, ...runtimePatch },
          }),
        }),
  };
}

interface BuildApprovalResolvedPatchInput {
  state: ChatStoreState;
  id: string;
  resolvedSessionKey?: string;
  decision?: ApprovalDecision;
}

export function buildApprovalResolvedPatch(
  input: BuildApprovalResolvedPatchInput,
): Partial<ChatStoreState> | null {
  const { state, id, resolvedSessionKey, decision } = input;
  let matchedSessionKey = resolvedSessionKey ?? '';
  if (!matchedSessionKey) {
    for (const [sessionKey, approvals] of Object.entries(state.pendingApprovalsBySession)) {
      if (approvals.some((item) => item.id === id)) {
        matchedSessionKey = sessionKey;
        break;
      }
    }
  }
  if (!matchedSessionKey) {
    return null;
  }

  const nextApprovals = { ...state.pendingApprovalsBySession };
  const sessionApprovals = nextApprovals[matchedSessionKey] ?? [];
  nextApprovals[matchedSessionKey] = sessionApprovals.filter((item) => item.id !== id);

  const stillPendingCurrent = (nextApprovals[state.currentSessionKey] ?? []).length > 0;
  const abortedCurrentByDeny = decision === 'deny' && matchedSessionKey === state.currentSessionKey;
  if (matchedSessionKey !== state.currentSessionKey) {
    return {
      pendingApprovalsBySession: nextApprovals,
    };
  }

  const currentRuntime = getSessionRuntime(state, state.currentSessionKey);
  const runtimePatch = reduceSessionRuntime(currentRuntime, {
    type: 'approval_resolved',
    stillPendingCurrent,
    abortedCurrentByDeny,
  });

  return {
    pendingApprovalsBySession: nextApprovals,
    ...(runtimePatch === currentRuntime
        ? {}
        : {
          loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
            runtime: { ...currentRuntime, ...runtimePatch },
          }),
        }),
  };
}

