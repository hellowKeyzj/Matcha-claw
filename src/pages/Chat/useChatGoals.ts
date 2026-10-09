import { useCallback, useMemo, useRef, useState } from 'react';
import { hostSessionGoalClear, hostSessionGoalUpdate } from '@/lib/host-api';
import { useChatStore, type ChatSendAttachment, type ChatSendResult } from '@/stores/chat';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionGoalView, SessionGoalUpdate, SessionGoalOutcome } from '@/types/session-goal';

type GoalAction = SessionGoalUpdate | { action: 'clear' };
type GoalTarget = { identity: SessionIdentity; recordKey: string; endpointSessionId: string };
type PendingOperation = { operationId: string; issuedAtMs: number; action: GoalAction['action'] | 'start'; draftId?: string; target?: GoalTarget; goalId?: string };
type GoalError = Exclude<SessionGoalOutcome['outcome'], 'succeeded'> | 'empty' | 'active' | 'missing-session' | 'goal-attachments' | 'error';
type ActionState = { busy: boolean; error: GoalError | null; unknown: boolean; canDiscard?: boolean; pending?: PendingOperation };
const IDLE: ActionState = { busy: false, error: null, unknown: false };

function goalSendError(result: Extract<ChatSendResult, { accepted: false }>): GoalError {
  if (result.outcome) return result.outcome;
  switch (result.reason) {
    case 'empty':
    case 'goal-attachments':
    case 'active':
    case 'missing-session':
    case 'error':
      return result.reason;
    case 'stopping':
      return 'active';
    case 'missing-session-identity':
    case 'loading-history':
    case 'history-error':
      return 'missing-session';
    case 'automation-session':
      return 'unsupported';
  }
}

async function readAuthority({ identity, recordKey, endpointSessionId }: GoalTarget) {
  const before = useChatStore.getState().loadedSessions[recordKey]?.meta.goalReadRevision;
  try {
    await useChatStore.getState().loadHistory({ sessionKey: recordKey, mode: 'quiet', scope: 'background', reason: 'manual_refresh' });
  } catch {
    return null;
  }
  const meta = useChatStore.getState().loadedSessions[recordKey]?.meta;
  return meta?.sessionIdentity && buildSessionIdentityKey(meta.sessionIdentity) === buildSessionIdentityKey(identity)
    && meta.endpointSessionId === endpointSessionId && meta.goal.kind === 'known'
    && before !== undefined && meta.goalReadRevision > before ? meta.goal : null;
}

export function useChatGoals(identity: SessionIdentity | null, recordKey: string, endpointSessionId: string | null, draftKey: string, enabled: boolean, view: SessionGoalView) {
  const mode = useComposerDraftStore((state) => state.modes[draftKey] ?? null);
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const statesRef = useRef(states);
  const state = states[mode?.id ?? ''] ?? states[recordKey] ?? IDLE;
  const publish = useCallback((key: string, value: ActionState, from?: string) => {
    const next = { ...statesRef.current, [key]: value };
    if (from && from !== key) delete next[from];
    statesRef.current = next;
    setStates(next);
  }, []);
  const currentState = useCallback(() => {
    const mode = useComposerDraftStore.getState().modes[draftKey];
    return statesRef.current[mode?.id ?? ''] ?? statesRef.current[recordKey] ?? IDLE;
  }, [draftKey, recordKey]);
  const target = useMemo(() => identity && endpointSessionId ? { identity, recordKey, endpointSessionId } : null, [endpointSessionId, identity, recordKey]);

  const begin = useCallback((goalId?: string, objective?: string) => {
    const state = currentState();
    const drafts = useComposerDraftStore.getState();
    if (!enabled || !draftKey || drafts.modes[draftKey] || state.busy || state.unknown) return false;
    drafts.setMode(draftKey, { kind: 'typedGoal', id: crypto.randomUUID(), ...(goalId ? { goalId } : {}) });
    if (objective !== undefined) drafts.setDraft(draftKey, objective);
    return true;
  }, [currentState, draftKey, enabled]);

  const mutate = useCallback(async (goalId: string, update: GoalAction, pending: PendingOperation, scope: string): Promise<SessionGoalOutcome> => {
    if (!target || !enabled || currentState().busy || currentState().unknown) return { outcome: 'unavailable' };
    pending = { ...pending, target, goalId };
    const input = { sessionIdentity: target.identity, endpointSessionId: target.endpointSessionId, goalId, operationId: pending.operationId, issuedAtMs: pending.issuedAtMs };
    publish(scope, { busy: true, error: null, unknown: false, pending });
    try {
      const result = update.action === 'clear' ? await hostSessionGoalClear(input) : await hostSessionGoalUpdate({ ...input, ...update });
      if (result.outcome !== 'succeeded') {
        publish(scope, { busy: false, error: result.outcome, unknown: result.outcome === 'unknown', pending });
        return result;
      }
      const receipt = result.receipt;
      if (receipt.operationId !== pending.operationId || receipt.goalId !== goalId || receipt.sessionId !== target.endpointSessionId
        || receipt.action !== update.action || update.action === 'resume' && !receipt.runId) {
        publish(scope, { busy: false, error: 'unknown', unknown: true, pending });
        return { outcome: 'unknown' };
      }
      // Receipts admit the operation; only a fresh native read confirms current facts.
      const confirmed = await readAuthority(target);
      publish(scope, { busy: false, error: confirmed ? null : 'unknown', unknown: !confirmed, pending });
      return result;
    } catch {
      publish(scope, { busy: false, error: 'unknown', unknown: true, pending });
      return { outcome: 'unknown' };
    }
  }, [currentState, enabled, publish, target]);

  const act = useCallback((goalId: string, update: GoalAction) => {
    if (useComposerDraftStore.getState().modes[draftKey]) return Promise.resolve<SessionGoalOutcome>({ outcome: 'unavailable' });
    return mutate(goalId, update, { operationId: crypto.randomUUID(), issuedAtMs: Date.now(), action: update.action }, recordKey);
  }, [draftKey, mutate, recordKey]);

  const submit = useCallback(async (text: string, attachments?: ChatSendAttachment[]): Promise<ChatSendResult> => {
    const drafts = useComposerDraftStore.getState();
    const mode = drafts.modes[draftKey];
    if (!enabled || !mode || currentState().busy || currentState().unknown) return { accepted: false, reason: 'error' };
    const pending: PendingOperation = { operationId: crypto.randomUUID(), issuedAtMs: Date.now(), action: mode.goalId ? 'edit' : 'start', draftId: mode.id };
    let result: ChatSendResult;
    if (mode.goalId) {
      const outcome = await mutate(mode.goalId, { action: 'edit', objective: text }, pending, mode.id);
      result = outcome.outcome === 'succeeded' ? { accepted: true, sessionRecordKey: recordKey }
        : { accepted: false, reason: 'error', outcome: outcome.outcome };
    } else {
      publish(mode.id, { busy: true, error: null, unknown: false, pending });
      try {
        result = await useChatStore.getState().sendMessage(text, attachments, { kind: 'goalStart', issuedAtMs: pending.issuedAtMs }, pending.operationId);
      } catch {
        result = { accepted: false, reason: 'error', outcome: 'unknown' };
      }
      const meta = result.sessionRecordKey ? useChatStore.getState().loadedSessions[result.sessionRecordKey]?.meta : null;
      const sendTarget = meta?.sessionIdentity && meta.endpointSessionId && result.sessionRecordKey
        ? { identity: meta.sessionIdentity, endpointSessionId: meta.endpointSessionId, recordKey: result.sessionRecordKey } : target;
      publish(mode.id, { busy: false, error: result.accepted ? null : goalSendError(result), unknown: !result.accepted && result.outcome === 'unknown', pending: { ...pending, ...(sendTarget ? { target: sendTarget } : {}) } });
    }
    const key = result.sessionRecordKey ?? draftKey;
    const operationState = statesRef.current[mode.id];
    if (result.accepted && operationState?.pending?.operationId === pending.operationId) {
      if (useComposerDraftStore.getState().modes[key]?.id === mode.id) useComposerDraftStore.getState().clearDraft(key);
      publish(result.sessionRecordKey ?? recordKey, operationState, mode.id);
    }
    return result;
  }, [currentState, draftKey, enabled, mutate, publish, recordKey, target]);

  const refresh = useCallback(async () => {
    const state = currentState();
    const readTarget = state.pending?.target ?? target;
    if (!readTarget || !enabled || state.busy) return false;
    const scope = mode?.id ?? recordKey;
    publish(scope, { ...state, busy: true });
    const view = await readAuthority(readTarget);
    if (!view) {
      publish(scope, { ...state, busy: false });
      return false;
    }
    const drafts = useComposerDraftStore.getState();
    if (state.unknown && state.pending?.action === 'start') {
      if (view.goal && drafts.modes[draftKey]?.id === state.pending.draftId) {
        drafts.clearDraft(draftKey);
        publish(recordKey, IDLE, scope);
      } else publish(scope, { ...state, busy: false, canDiscard: true });
    } else {
      if (state.unknown && state.pending?.draftId && state.pending.action === 'edit'
        && (!view.goal || view.goal.id !== state.pending.goalId)
        && drafts.modes[draftKey]?.id === state.pending.draftId) drafts.setMode(draftKey, null);
      publish(scope, IDLE);
    }
    return true;
  }, [currentState, draftKey, enabled, mode?.id, publish, recordKey, target]);

  const cancel = useCallback(() => {
    const state = currentState();
    const drafts = useComposerDraftStore.getState();
    if (!mode || drafts.modes[draftKey]?.id !== mode.id || state.busy || state.unknown && !state.canDiscard) return;
    if (state.unknown) drafts.clearDraft(draftKey);
    else drafts.setMode(draftKey, null);
    publish(recordKey, IDLE, mode.id);
  }, [currentState, draftKey, mode, publish, recordKey]);

  const goal = view.kind === 'known' ? view.goal : null;
  const dock = view.kind !== 'unsupported' && (goal || state.unknown) ? { goal } : null;
  return { ...state, dock, mode, begin, submit, cancel, act, refresh };
}
