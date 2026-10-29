import { hostSessionLoad, hostSessionPatch, hostSessionPermissionGet, hostSessionPermissionSet, hostSessionThinkingGet, hostSessionThinkingSet } from '@/lib/host-api';
import type { HostSessionModelSelectionResult } from '@/lib/host-api';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { buildSessionIdentityKey, sessionIdentitiesEqual, sessionScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionSendIntent } from '@/types/session-goal';
import type { SessionPermissionSelection, SessionPermissionSetResult } from '@/types/session-permission';
import type { SessionThinkingResult } from '@/types/session-thinking';
import { readComposerDraftSnapshot, useComposerDraftStore, type ComposerDraftSnapshot, type ComposerThinkingSelection } from '@/plugins/chat/composer-drafts';
import { decodeHistorySessionView } from '@/plugins/chat/store/history-fetch-helpers';
import type { NewSessionResult } from '@/plugins/chat/store/session-actions';
import type { ChatStoreGetFn, ChatStoreSetFn } from '@/plugins/chat/store/send-handlers';
import { selectCurrentChatSendGate } from '@/plugins/chat/store/selectors';
import { resolveChatSendGateForPayload } from '@/plugins/chat/store/send-gate';
import { currentSessionSend } from '@/plugins/chat/store/send-state';
import { isReadableChatAttachment, isUnsupportedGoalStartAttachment } from '@/plugins/chat/store/send-transport';
import { resolveSessionOperationTarget } from '@/plugins/chat/store/session-identity';
import { reconcileSessionDirectory } from '@/plugins/chat/store/session-directory';
import { hasPendingSessionSend } from '@/plugins/chat/store/session-presentation';
import { getSessionRuntime, patchSessionMeta } from '@/plugins/chat/store/store-state-helpers';
import type { ChatSendAttachment, ChatSendResult, ChatStoreState } from '@/plugins/chat/store/types';

interface SessionInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  subscribe?: (listener: (state: ChatStoreState) => void) => () => void;
}
interface ComposerSendInput extends SessionInput {
  subscribe: (listener: (state: ChatStoreState) => void) => () => void;
  create: (draft: { key: string; operationId: string; snapshot: ComposerDraftSnapshot; isCurrent: () => boolean }) => Promise<NewSessionResult>;
  send: () => Promise<ChatSendResult>;
}

const activeComposerSends = new Set<string>();
const modelSelections = new Map<string, symbol>();

export async function executeSessionModelSelection(input: SessionInput, key: string, selectionId: string): Promise<HostSessionModelSelectionResult> {
  const normalized = selectionId.trim();
  const state = input.get();
  const record = state.loadedSessions[key];
  const runtime = getSessionRuntime(state, key);
  if (!normalized || !record?.meta.sessionIdentity || hasPendingSessionSend(record) || runtime.activeRunId || runtime.pendingTurnKey
    || runtime.activeTurnItemKey || ['submitted', 'streaming', 'waiting_tool', 'finalizing', 'stopping'].includes(runtime.runPhase)) {
    return { outcome: 'target_rejected' };
  }
  const identity = record.meta.sessionIdentity;
  const identityKey = buildSessionIdentityKey(identity);
  if (modelSelections.has(identityKey)) return { outcome: 'target_rejected' };
  const operation = Symbol();
  const conversation = input.get().currentConversation;
  let retired = false;
  const unsubscribe = input.subscribe?.((state) => { if (state.currentConversation !== conversation) retired = true; });
  modelSelections.set(identityKey, operation);
  try {
    const target = resolveSessionOperationTarget(input.get(), key);
    const result = await hostSessionPatch({
      ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
      sessionIdentity: target.sessionIdentity,
      modelSelectionId: normalized,
    });
    if (retired || modelSelections.get(identityKey) !== operation
      || input.get().loadedSessions[key]?.meta.sessionIdentity !== identity) return { outcome: 'outcome_unknown' };
    if (result.outcome === 'succeeded') {
      if (result.modelState.selectionId !== normalized) return { outcome: 'outcome_unknown' };
      input.set((state) => {
        if (state.loadedSessions[key]?.meta.sessionIdentity !== identity) return state;
        const loadedSessions = patchSessionMeta(state, key, { modelState: result.modelState });
        return { loadedSessions, ...reconcileSessionDirectory(state, loadedSessions, [key]) };
      });
    }
    return result;
  } finally {
    unsubscribe?.();
    if (modelSelections.get(identityKey) === operation) modelSelections.delete(identityKey);
  }
}

async function applySessionThinkingSelection(identity: SessionIdentity, selection: ComposerThinkingSelection, isCurrent: () => boolean, recovering: boolean, traceId = createSessionTraceId('thinking-configure')): Promise<SessionThinkingResult> {
  logSessionTrace('thinking.configure.start', traceId, () => ({
    owner: summarizeIdentifier(buildSessionIdentityKey(identity)), recovering,
    requested: summarizeIdentifier(selection.level), reset: selection.level === null,
  }));
  if (identity.endpoint.kind !== 'native-runtime' || identity.endpoint.runtimeAdapterId !== selection.runtime) {
    logSessionTrace('thinking.configure.rejected', traceId, () => ({ reason: 'runtime-mismatch' }));
    return { runtime: selection.runtime, outcome: 'rejected' };
  }
  if (recovering) {
    const current = await hostSessionThinkingGet({ scope: sessionScope(identity) }, { traceId });
    if (!isCurrent()) {
      logSessionTrace('thinking.configure.stale', traceId, () => ({ phase: 'get', outcome: current.outcome }));
      return { runtime: selection.runtime, outcome: 'unavailable' };
    }
    if (current.outcome === 'available') {
      if (selection.level !== null && !current.options.includes(selection.level)) {
        logSessionTrace('thinking.configure.rejected', traceId, () => ({ reason: 'incompatible-intent' }));
        return { runtime: selection.runtime, outcome: 'rejected' };
      }
      if (current.level === selection.level) return current;
    } else if (selection.level !== null || current.outcome !== 'unsupported') return current;
  }
  if (!isCurrent()) {
    logSessionTrace('thinking.configure.stale', traceId, () => ({ phase: 'before-set' }));
    return { runtime: selection.runtime, outcome: 'unavailable' };
  }
  return hostSessionThinkingSet({ identity, level: selection.level }, { traceId });
}

export async function executeSessionThinkingSelection(input: SessionInput, key: string, selection: ComposerThinkingSelection, traceId = createSessionTraceId('thinking-write')): Promise<SessionThinkingResult> {
  const state = input.get();
  const record = state.loadedSessions[key];
  const identity = record?.meta.sessionIdentity;
  const conversation = state.currentConversation;
  const send = record ? currentSessionSend(record) : null;
  const reason = !identity ? 'missing-identity'
    : conversation?.kind !== 'session' || conversation.sessionRecordKey !== key
      || !sessionIdentitiesEqual(conversation.sessionIdentity, identity) ? 'target-changed'
      : getSessionRuntime(state, key).runPhase === 'stopping' ? 'closing'
        : record?.meta.kind === 'automation' ? 'automation-session'
          : send?.receipt.phase === 'awaiting-receipt' || send?.receipt.phase === 'unknown' ? 'sending'
            : activeComposerSends.has(key) ? 'composer-busy'
              : modelSelections.has(buildSessionIdentityKey(identity)) ? 'model-busy'
                : useComposerDraftStore.getState().initializations[key] ? 'initialization-busy' : null;
  logSessionTrace('thinking.write.enter', traceId, () => ({
    owner: summarizeIdentifier(identity ? buildSessionIdentityKey(identity) : null),
    model: summarizeIdentifier(record?.meta.modelState?.selectionId),
    requested: summarizeIdentifier(selection.level), reset: selection.level === null, reason,
  }));
  if (!identity || reason) return { runtime: selection.runtime, outcome: 'rejected' };
  let retired = false;
  const unsubscribe = input.subscribe?.((next) => { if (next.currentConversation !== conversation) retired = true; });
  const operationId = crypto.randomUUID();
  const drafts = useComposerDraftStore.getState();
  activeComposerSends.add(key);
  drafts.setThinkingSelection(key, selection);
  const revision = useComposerDraftStore.getState().configurations[key].revision;
  drafts.setInitialization(key, { kind: 'pending', operationId, sessionRecordKey: key, sessionIdentity: identity });
  const isCurrent = () => !retired && input.get().currentConversation === conversation
    && input.get().loadedSessions[key]?.meta.sessionIdentity === identity
    && useComposerDraftStore.getState().configurations[key]?.revision === revision;
  let result: SessionThinkingResult;
  try {
    try {
      result = await applySessionThinkingSelection(identity, selection, isCurrent, false, traceId);
    } catch (error) {
      logSessionTrace('thinking.configure.error', traceId, () => summarizeError(error));
      result = { runtime: selection.runtime, outcome: 'unknown' };
    }
    logSessionTrace('thinking.configure.settle', traceId, () => ({ outcome: result.outcome, stale: !isCurrent() }));
    if (!isCurrent()) result = { runtime: selection.runtime, outcome: 'unknown' };
    const composer = useComposerDraftStore.getState();
    const pending = composer.initializations[key];
    if (pending?.kind === 'pending' && pending.operationId === operationId) {
      if (isCurrent() && result.outcome === 'confirmed') {
        composer.confirmConfiguration(key, revision, 'thinkingSelection');
        composer.setInitialization(key, null);
      } else {
        composer.setInitialization(key, {
          ...pending, outcome: result.outcome === 'confirmed' || result.outcome === 'available' ? 'unknown' : result.outcome,
          error: `Session thinking ${result.outcome}`,
        });
      }
    }
    return result;
  } finally {
    unsubscribe?.();
    activeComposerSends.delete(key);
  }
}

function permissionConfirmed(result: SessionPermissionSetResult, selection: SessionPermissionSelection): boolean {
  if (result.runtime !== selection.runtime || !('mode' in result) || result.mode !== selection.mode) return false;
  return result.runtime === 'matcha-agent'
    ? result.outcome === 'confirmed' && result.persisted === true
    : result.outcome === 'available' && result.supported && !result.pending;
}

export async function executeComposerSend(input: ComposerSendInput, payload: {
  text: string; attachments?: ChatSendAttachment[]; intent?: SessionSendIntent; operationId?: string;
}): Promise<ChatSendResult> {
  const { text, attachments, intent } = payload;
  if (intent && !text.trim()) return { accepted: false, reason: 'empty' };
  if (intent && attachments?.some(isUnsupportedGoalStartAttachment)) {
    return { accepted: false, reason: 'goal-attachments' };
  }
  const attachmentCount = attachments?.filter(isReadableChatAttachment).length ?? 0;
  const gate = resolveChatSendGateForPayload(selectCurrentChatSendGate(input.get()), { text, attachmentCount });
  if (!gate.canSend) return { accepted: false, reason: gate.reason, error: gate.error };
  let conversation = input.get().currentConversation;
  let key = gate.kind === 'draft' ? `${gate.runtimeScopeKey}:agent:${gate.agentId}:draft` : gate.sessionKey;
  const sourceKey = key;
  let snapshot = readComposerDraftSnapshot(key);
  const submission = !intent && payload.operationId ? useComposerDraftStore.getState().submissions[key] : undefined;
  const ownsSubmission = Boolean(submission && submission.operationId === payload.operationId);
  const initialization = useComposerDraftStore.getState().initializations[key];
  if (activeComposerSends.has(key) || gate.kind === 'session' && modelSelections.has(buildSessionIdentityKey(gate.sessionIdentity))
    || initialization?.kind === 'creating') return { accepted: false, reason: 'active', dispatch: 'not-dispatched' };
  if (initialization?.kind === 'createUnknown') return { accepted: false, reason: 'error', error: initialization.error, dispatch: 'not-dispatched' };
  if (gate.kind === 'session' && !initialization) {
    if (ownsSubmission && !useComposerDraftStore.getState().takeSubmission(key, payload.operationId!)) {
      return { accepted: false, reason: 'active', dispatch: 'not-dispatched' };
    }
    try {
      const result = await input.send();
      if (ownsSubmission) useComposerDraftStore.getState().settleSubmission(key, payload.operationId!, result);
      return result;
    } catch (error) {
      if (ownsSubmission) useComposerDraftStore.getState().settleSubmission(key, payload.operationId!, {
        accepted: false, reason: 'error', outcome: 'unknown', error: String(error),
      });
      throw error;
    }
  }
  const operationId = ownsSubmission ? payload.operationId! : initialization?.operationId ?? payload.operationId ?? crypto.randomUUID();
  let retired = false;
  let phase: 'create' | 'permission' | 'model' | 'thinking' | 'send' = 'create';
  let identity: SessionIdentity | null = gate.kind === 'session' ? gate.sessionIdentity : null;
  const unsubscribe = input.subscribe((state) => {
    if (state.currentConversation === conversation) return;
    const next = state.currentConversation;
    const target = next?.kind === 'session' ? useComposerDraftStore.getState().initializations[next.sessionRecordKey] : null;
    if (!retired && phase === 'create' && conversation?.kind === 'draft' && next?.kind === 'session'
      && target?.kind === 'pending' && target.operationId === operationId) conversation = next;
    else retired = true;
  });
  const isCurrent = () => !retired && input.get().currentConversation === conversation
    && (identity === null || input.get().loadedSessions[key]?.meta.sessionIdentity === identity);
  const sameRevision = () => (ownsSubmission
    ? useComposerDraftStore.getState().submissions[key]?.operationId === operationId
    : useComposerDraftStore.getState().revisions[key] === snapshot.revision)
    && useComposerDraftStore.getState().configurations[key]?.revision === snapshot.configuration?.revision;
  const fail = (error: string, outcome: 'unsupported' | 'unavailable' | 'rejected' | 'unknown' = 'unknown'): ChatSendResult => {
    const current = useComposerDraftStore.getState().initializations[key];
    if (current?.kind === 'pending' && current.operationId === operationId) {
      useComposerDraftStore.getState().setInitialization(key, { ...current, outcome, error });
    }
    if (isCurrent()) input.set({ error });
    const result: ChatSendResult = { accepted: false, reason: 'error', error, dispatch: 'not-dispatched', ...(identity ? { sessionRecordKey: key } : {}) };
    if (ownsSubmission) useComposerDraftStore.getState().settleSubmission(key, operationId, result);
    return result;
  };
  activeComposerSends.add(sourceKey);
  try {
    if (ownsSubmission && !useComposerDraftStore.getState().takeSubmission(key, operationId)) {
      return { accepted: false, reason: 'active', dispatch: 'not-dispatched' };
    }
    if (gate.kind === 'draft') {
      useComposerDraftStore.getState().setInitialization(key, { kind: 'creating', operationId });
      const created = await input.create({ key, operationId, snapshot, isCurrent: () => isCurrent() && sameRevision() });
      if (created.outcome !== 'created') {
        if (useComposerDraftStore.getState().initializations[key]?.operationId === operationId) {
          useComposerDraftStore.getState().setInitialization(key, created.outcome === 'unknown'
            ? { kind: 'createUnknown', operationId, error: created.error } : null);
        }
        return fail(created.error, created.outcome);
      }
      key = created.sessionRecordKey;
      activeComposerSends.add(key);
      identity = input.get().loadedSessions[key]?.meta.sessionIdentity ?? created.sessionIdentity;
      if (created.error) return fail(created.error);
      // A successful create selects a new conversation only while the captured draft still owns selection.
      const currentConversation = input.get().currentConversation;
      const selectedCreated = currentConversation?.kind === 'session' && currentConversation.sessionRecordKey === key;
      if (retired || !selectedCreated || !identity || !sessionIdentitiesEqual(identity, created.sessionIdentity)) {
        return fail('Conversation changed before session configuration', 'unavailable');
      }
      if (!ownsSubmission) snapshot = readComposerDraftSnapshot(key);
    } else {
      if (initialization?.kind !== 'pending' || !sessionIdentitiesEqual(initialization.sessionIdentity, gate.sessionIdentity)) {
        return fail('Session initialization target changed');
      }
      useComposerDraftStore.getState().setInitialization(key, {
        kind: 'pending', operationId, sessionRecordKey: key, sessionIdentity: gate.sessionIdentity,
      });
    }
    if (!identity || !isCurrent() || !sameRevision()) return fail('Composer changed before session configuration', 'unavailable');
    const configuration = snapshot.configuration;
    const selection = configuration?.permissionSelection;
    if (selection) {
      phase = 'permission';
      // Recovery reads native state first; a durable Matcha read is not a live-application receipt.
      if (initialization?.kind === 'pending') {
        const result = await hostSessionPermissionGet({ identity });
        if (!isCurrent() || !sameRevision()) return fail('Composer changed during permission confirmation', 'unavailable');
        if (result.runtime === 'openclaw' && selection.runtime === 'openclaw'
          && result.outcome === 'available' && result.mode === selection.mode && !result.pending) {
          useComposerDraftStore.getState().confirmConfiguration(key, configuration.revision, 'permissionSelection');
        } else if (result.outcome !== 'available') return fail(`Session permission ${result.outcome}`, result.outcome);
      }
      if (useComposerDraftStore.getState().configurations[key]?.permissionSelection) {
        const result = await hostSessionPermissionSet({ identity, selection });
        if (!isCurrent() || !sameRevision()) return fail('Composer changed during permission configuration', 'unavailable');
        if (!permissionConfirmed(result, selection)) {
          return fail(`Session permission ${result.outcome}`, result.outcome === 'available' || result.outcome === 'confirmed' ? 'unknown' : result.outcome);
        }
        useComposerDraftStore.getState().confirmConfiguration(key, configuration.revision, 'permissionSelection');
      }
    }
    if (configuration?.modelSelectionId && configuration.thinkingSelection?.level === null) {
      phase = 'thinking';
      const result = await applySessionThinkingSelection(identity, configuration.thinkingSelection, () => isCurrent() && sameRevision(), initialization?.kind === 'pending');
      if (!isCurrent() || !sameRevision()) return fail('Composer changed during thinking reset', 'unavailable');
      if (result.outcome !== 'confirmed' && result.outcome !== 'available') return fail(`Session thinking ${result.outcome}`, result.outcome);
      useComposerDraftStore.getState().confirmConfiguration(key, configuration.revision, 'thinkingSelection');
    }
    if (!isCurrent() || !sameRevision()) return fail('Composer changed before model configuration', 'unavailable');
    const modelSelectionId = configuration?.modelSelectionId;
    if (modelSelectionId) {
      phase = 'model';
      let confirmed = false;
      if (initialization?.kind === 'pending') {
        const view = decodeHistorySessionView(await hostSessionLoad({ sessionIdentity: identity, limit: 1 }));
        if (!sessionIdentitiesEqual(view.identity, identity)) return fail('Session model confirmation target changed');
        if (!isCurrent() || !sameRevision()) return fail('Composer changed during model confirmation', 'unavailable');
        confirmed = view.modelState?.selectionId === modelSelectionId;
        if (confirmed) input.set((state) => {
          const loadedSessions = patchSessionMeta(state, key, { modelState: view.modelState! });
          return { loadedSessions, ...reconcileSessionDirectory(state, loadedSessions, [key]) };
        });
      }
      if (!confirmed) {
        const result = await input.get().selectSessionModel(key, modelSelectionId);
        if (!isCurrent() || !sameRevision()) return fail('Composer changed during model configuration', 'unavailable');
        if (result.outcome !== 'succeeded') return fail(`Session model ${result.outcome}`, result.outcome === 'target_rejected' ? 'rejected' : 'unknown');
      }
      useComposerDraftStore.getState().confirmConfiguration(key, configuration!.revision, 'modelSelectionId');
    }
    if (!isCurrent() || !sameRevision()) return fail('Composer changed before thinking configuration', 'unavailable');
    const thinkingSelection = useComposerDraftStore.getState().configurations[key]?.thinkingSelection;
    if (thinkingSelection) {
      phase = 'thinking';
      const result = await applySessionThinkingSelection(identity, thinkingSelection, () => isCurrent() && sameRevision(), initialization?.kind === 'pending');
      if (!isCurrent() || !sameRevision()) return fail('Composer changed during thinking configuration', 'unavailable');
      if (result.outcome !== 'confirmed' && result.outcome !== 'available') return fail(`Session thinking ${result.outcome}`, result.outcome);
      useComposerDraftStore.getState().confirmConfiguration(key, configuration!.revision, 'thinkingSelection');
    }
    if (!isCurrent() || !sameRevision()) return fail('Composer changed before sending', 'unavailable');
    phase = 'send';
    const result = await input.send().catch((error): ChatSendResult => {
      if (!ownsSubmission) throw error;
      return { accepted: false, reason: 'error', outcome: 'unknown', error: String(error) };
    });
    if (result.accepted || result.outcome === 'unknown') {
      const current = useComposerDraftStore.getState().initializations[key];
      if (current?.operationId === operationId) {
        if (sameRevision()) useComposerDraftStore.getState().setInitialization(key, null);
        else if (current.kind === 'pending') useComposerDraftStore.getState().setInitialization(key, {
          ...current, outcome: 'unavailable', error: 'Composer changed during send',
        });
      }
      if (result.accepted && gate.kind === 'draft' && !intent && !ownsSubmission) useComposerDraftStore.getState().settleDraft(key, snapshot.revision);
    } else {
      const current = useComposerDraftStore.getState().initializations[key];
      if (current?.kind === 'pending' && current.operationId === operationId) {
        useComposerDraftStore.getState().setInitialization(key, { ...current, outcome: 'rejected', error: result.error ?? 'Session send was not accepted' });
      }
    }
    if (ownsSubmission) useComposerDraftStore.getState().settleSubmission(key, operationId, result);
    return { ...result, sessionRecordKey: key };
  } catch (error) {
    if (phase === 'send') {
      if (ownsSubmission) useComposerDraftStore.getState().settleSubmission(key, operationId, {
        accepted: false, reason: 'error', outcome: 'unknown', error: String(error),
      });
      throw error;
    }
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    unsubscribe();
    activeComposerSends.delete(sourceKey);
    activeComposerSends.delete(key);
  }
}
