import type {
  ChatCurrentConversation,
  ChatRunPhase,
  ChatSendGate,
  ChatSessionHistoryStatus,
  ChatSessionMetaState,
  ChatStoreState,
} from './types';
import { isRunActive } from './types';
import type { RuntimeEndpointRef, SessionIdentity } from '../../types/desktop/runtime-address';

export type { ChatSendGate } from './types';

export type CurrentChatSendGateSource =
  | {
    kind: 'draft';
    runtimeScopeKey: string;
    endpoint: RuntimeEndpointRef;
    agentId: string;
  }
  | {
    kind: 'session';
    sessionKey: string;
    endpointSessionId: string | null;
    sessionIdentity: SessionIdentity | null;
    historyStatus: ChatSessionHistoryStatus | null;
    sessionKind: ChatSessionMetaState['kind'];
    runPhase: ChatRunPhase | null;
    activeRunId: string | null;
    pendingTurnKey: string | null;
    activeTurnItemKey: string | null;
  };

function resolveCurrentSessionKey(input: {
  currentConversation: ChatCurrentConversation | null;
  currentSessionKey: string;
}): string {
  return input.currentSessionKey
    || (input.currentConversation?.kind === 'session' ? input.currentConversation.sessionRecordKey : '');
}

export function readCurrentChatSendGateSource(state: ChatStoreState): CurrentChatSendGateSource {
  if (state.currentConversation?.kind === 'draft') {
    return {
      kind: 'draft',
      runtimeScopeKey: state.currentConversation.runtimeScopeKey,
      endpoint: state.currentConversation.endpoint,
      agentId: state.currentConversation.agentId,
    };
  }

  const sessionKey = resolveCurrentSessionKey({
    currentConversation: state.currentConversation,
    currentSessionKey: state.currentSessionKey,
  });
  const record = sessionKey ? state.loadedSessions[sessionKey] : undefined;
  return {
    kind: 'session',
    sessionKey,
    endpointSessionId: record?.meta.endpointSessionId ?? null,
    sessionIdentity: record?.meta.sessionIdentity ?? null,
    historyStatus: record?.meta.historyStatus ?? null,
    sessionKind: record?.meta.kind ?? null,
    runPhase: record?.runtime.runPhase ?? null,
    activeRunId: record?.runtime.activeRunId ?? null,
    pendingTurnKey: record?.runtime.pendingTurnKey ?? null,
    activeTurnItemKey: record?.runtime.activeTurnItemKey ?? null,
  };
}

export function areCurrentChatSendGateSourcesEquivalent(
  left: CurrentChatSendGateSource,
  right: CurrentChatSendGateSource,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'draft' && right.kind === 'draft') {
    return left.runtimeScopeKey === right.runtimeScopeKey
      && left.endpoint === right.endpoint
      && left.agentId === right.agentId;
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return left.sessionKey === right.sessionKey
      && left.endpointSessionId === right.endpointSessionId
      && left.sessionIdentity === right.sessionIdentity
      && left.historyStatus === right.historyStatus
      && left.sessionKind === right.sessionKind
      && left.runPhase === right.runPhase
      && left.activeRunId === right.activeRunId
      && left.pendingTurnKey === right.pendingTurnKey
      && left.activeTurnItemKey === right.activeTurnItemKey;
  }
  return false;
}

export function deriveChatSendGate(source: CurrentChatSendGateSource): ChatSendGate {
  if (source.kind === 'draft') {
    return {
      canSend: true,
      kind: 'draft',
      runtimeScopeKey: source.runtimeScopeKey,
      endpoint: source.endpoint,
      agentId: source.agentId,
    };
  }

  if (!source.sessionKey) {
    return { canSend: false, reason: 'missing-session' };
  }
  if (!source.historyStatus) {
    return { canSend: false, reason: 'missing-session', sessionKey: source.sessionKey };
  }
  if (source.historyStatus === 'loading') {
    return { canSend: false, reason: 'loading-history', sessionKey: source.sessionKey };
  }
  if (source.historyStatus === 'error') {
    return { canSend: false, reason: 'history-error', sessionKey: source.sessionKey };
  }
  if (!source.sessionIdentity) {
    return { canSend: false, reason: 'missing-session-identity', sessionKey: source.sessionKey };
  }
  if (source.runPhase === 'stopping') {
    return { canSend: false, reason: 'stopping', sessionKey: source.sessionKey };
  }
  if (source.sessionKind === 'automation') {
    return { canSend: false, reason: 'automation-session', sessionKey: source.sessionKey };
  }
  if (
    (source.runPhase != null && isRunActive({ runPhase: source.runPhase }))
    || source.activeRunId != null
    || source.pendingTurnKey != null
    || source.activeTurnItemKey != null
  ) {
    return { canSend: false, reason: 'active', sessionKey: source.sessionKey };
  }

  return {
    canSend: true,
    kind: 'session',
    sessionKey: source.sessionKey,
    endpointSessionId: source.endpointSessionId ?? undefined,
    sessionIdentity: source.sessionIdentity,
  };
}

export function resolveChatSendGateForPayload(
  gate: ChatSendGate,
  payload: { text: string; attachmentCount: number; selectedSkillCount?: number },
): ChatSendGate {
  if (!gate.canSend) {
    return gate;
  }
  if (!payload.text.trim() && payload.attachmentCount === 0 && (payload.selectedSkillCount ?? 0) === 0) {
    return gate.kind === 'session'
      ? { canSend: false, reason: 'empty', sessionKey: gate.sessionKey }
      : { canSend: false, reason: 'empty' };
  }
  return gate;
}

export function isChatSendGateOpen(gate: ChatSendGate): boolean {
  return gate.canSend;
}
