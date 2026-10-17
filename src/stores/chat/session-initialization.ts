import { hostSessionLoad, hostSessionPatch, hostSessionPermissionGet, hostSessionPermissionSet } from '@/lib/host-api';
import type { HostSessionModelSelectionResult } from '@/lib/host-api';
import { buildSessionIdentityKey, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionSendIntent } from '@/types/session-goal';
import type { SessionPermissionSelection, SessionPermissionSetResult } from '@/types/session-permission';
import { readComposerDraftSnapshot, useComposerDraftStore, type ComposerDraftSnapshot } from '../composer-drafts';
import { decodeHistorySessionView } from './history-fetch-helpers';
import type { NewSessionResult } from './session-actions';
import type { ChatStoreGetFn, ChatStoreSetFn } from './send-handlers';
import { selectCurrentChatSendGate } from './selectors';
import { resolveChatSendGateForPayload } from './send-gate';
import { resolveSessionOperationTarget } from './session-identity';
import { patchSessionMeta } from './store-state-helpers';
import { CHAT_INLINE_ATTACHMENT_MAX_BYTES, type ChatSendAttachment, type ChatSendResult, type ChatStoreState } from './types';

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
  const record = input.get().loadedSessions[key];
  if (!normalized || !record?.meta.sessionIdentity || record.runtime.activeRunId || record.runtime.pendingTurnKey
    || record.runtime.activeTurnItemKey || ['submitted', 'streaming', 'waiting_tool', 'finalizing', 'stopping'].includes(record.runtime.runPhase)) {
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
      input.set((state) => state.loadedSessions[key]?.meta.sessionIdentity === identity
        ? { loadedSessions: patchSessionMeta(state, key, { modelState: result.modelState }) } : state);
    }
    return result;
  } finally {
    unsubscribe?.();
    if (modelSelections.get(identityKey) === operation) modelSelections.delete(identityKey);
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
  const directory = (attachment: ChatSendAttachment) => attachment.entryKind === 'directory' || attachment.mimeType === 'application/x-directory';
  if (intent && !text.trim()) return { accepted: false, reason: 'empty' };
  if (intent && attachments?.some((attachment) => directory(attachment) || attachment.fileSize > CHAT_INLINE_ATTACHMENT_MAX_BYTES)) {
    return { accepted: false, reason: 'goal-attachments' };
  }
  const attachmentCount = attachments?.filter((attachment) => !directory(attachment)
    && (attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES || Boolean(attachment.sourcePath))).length ?? 0;
  const gate = resolveChatSendGateForPayload(selectCurrentChatSendGate(input.get()), { text, attachmentCount });
  if (!gate.canSend) return { accepted: false, reason: gate.reason, error: gate.error };
  let conversation = input.get().currentConversation;
  let key = gate.kind === 'draft' ? `${gate.runtimeScopeKey}:agent:${gate.agentId}:draft` : gate.sessionKey;
  const sourceKey = key;
  let snapshot = readComposerDraftSnapshot(key);
  const initialization = useComposerDraftStore.getState().initializations[key];
  if (activeComposerSends.has(key) || initialization?.kind === 'creating') return { accepted: false, reason: 'active', dispatch: 'not-dispatched' };
  if (initialization?.kind === 'createUnknown') return { accepted: false, reason: 'error', error: initialization.error, dispatch: 'not-dispatched' };
  if (gate.kind === 'session' && !initialization) return input.send();
  const operationId = initialization?.operationId ?? payload.operationId ?? crypto.randomUUID();
  let retired = false;
  let phase: 'create' | 'permission' | 'model' | 'send' = 'create';
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
  const sameRevision = () => useComposerDraftStore.getState().revisions[key] === snapshot.revision
    && useComposerDraftStore.getState().configurations[key]?.revision === snapshot.configuration?.revision;
  const fail = (error: string, outcome: 'unsupported' | 'unavailable' | 'rejected' | 'unknown' = 'unknown'): ChatSendResult => {
    const current = useComposerDraftStore.getState().initializations[key];
    if (current?.kind === 'pending' && current.operationId === operationId) {
      useComposerDraftStore.getState().setInitialization(key, { ...current, outcome, error });
    }
    if (isCurrent()) input.set({ error });
    return { accepted: false, reason: 'error', error, dispatch: 'not-dispatched', ...(identity ? { sessionRecordKey: key } : {}) };
  };
  activeComposerSends.add(sourceKey);
  try {
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
      snapshot = readComposerDraftSnapshot(key);
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
        if (confirmed) input.set((state) => ({ loadedSessions: patchSessionMeta(state, key, { modelState: view.modelState! }) }));
      }
      if (!confirmed) {
        const result = await input.get().selectSessionModel(key, modelSelectionId);
        if (!isCurrent() || !sameRevision()) return fail('Composer changed during model configuration', 'unavailable');
        if (result.outcome !== 'succeeded') return fail(`Session model ${result.outcome}`, result.outcome === 'target_rejected' ? 'rejected' : 'unknown');
      }
      useComposerDraftStore.getState().confirmConfiguration(key, configuration!.revision, 'modelSelectionId');
    }
    if (!isCurrent() || !sameRevision()) return fail('Composer changed before sending', 'unavailable');
    phase = 'send';
    const result = await input.send();
    if (result.accepted || result.outcome === 'unknown') {
      const current = useComposerDraftStore.getState().initializations[key];
      if (current?.operationId === operationId) {
        if (sameRevision()) useComposerDraftStore.getState().setInitialization(key, null);
        else if (current.kind === 'pending') useComposerDraftStore.getState().setInitialization(key, {
          ...current, outcome: 'unavailable', error: 'Composer changed during send',
        });
      }
      if (result.accepted && gate.kind === 'draft' && !intent) useComposerDraftStore.getState().settleDraft(key, snapshot.revision);
    } else fail(result.error ?? 'Session send was not accepted', 'rejected');
    return { ...result, sessionRecordKey: key };
  } catch (error) {
    if (phase === 'send') throw error;
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    unsubscribe();
    activeComposerSends.delete(sourceKey);
    activeComposerSends.delete(key);
  }
}
