import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { ChatStoreState } from '@/plugins/chat/store/types';
import { findSessionRecordKey, inferUntitledSessionLabel, resolveSessionListLabel } from './session-catalog';

export function selectSessionRuntimeByIdentity(
  state: Pick<ChatStoreState, 'loadedSessions' | 'sessionRecordKeyByIdentityKey'>,
  identity: SessionIdentity,
) {
  const key = findSessionRecordKey(state, identity);
  return key ? state.loadedSessions[key]?.runtime : undefined;
}

export function selectPendingApprovalsBySession(state: Pick<ChatStoreState, 'pendingApprovalsBySession'>) {
  return state.pendingApprovalsBySession;
}

export function resolveSessionNavigationTitle(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const record = state.loadedSessions[sessionKey];
  if (!record) return sessionKey;
  const label = resolveSessionListLabel(state, sessionKey);
  const { sessionIdentity, ownership, kind, endpointSessionId } = record.meta;
  return label || (sessionIdentity
    ? inferUntitledSessionLabel({
        key: sessionKey,
        agentId: record.meta.agentId ?? sessionIdentity.agentId,
        sessionIdentity,
        ownership,
        kind: kind ?? undefined,
        endpointSessionId: endpointSessionId ?? undefined,
      }, t)
    : t('sidebar.untitledSession'));
}
