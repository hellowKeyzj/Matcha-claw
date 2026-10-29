import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import { useChatStore } from './store';
import { DEFAULT_SESSION_KEY } from './store/types';
import { reconcileSessionDirectory } from './store/session-directory';
import { reconcileSessionSelectionAfterRemoval } from './store/session-selection';

/** Forgets loaded sessions after their owning workflow confirms deletion. */
export function forgetOwnedSessions(identities: readonly SessionIdentity[]): void {
  if (identities.length === 0) return;
  useChatStore.setState((state) => {
    const identityKeys = new Set(identities.map(buildSessionIdentityKey));
    const removed = new Set(Object.entries(state.loadedSessions)
      .filter(([, record]) => record.meta.sessionIdentity && identityKeys.has(buildSessionIdentityKey(record.meta.sessionIdentity)))
      .map(([key]) => key));
    if (removed.size === 0) return state;
    const loadedSessions = Object.fromEntries(
      Object.entries(state.loadedSessions).filter(([key]) => !removed.has(key)),
    );
    const replacement = removed.has(state.currentSessionKey)
      ? { kind: 'record' as const, sessionKey: Object.keys(loadedSessions)[0] ?? DEFAULT_SESSION_KEY }
      : undefined;
    return {
      loadedSessions,
      ...reconcileSessionSelectionAfterRemoval({ ...state, loadedSessions }, removed, replacement),
      ...reconcileSessionDirectory(state, loadedSessions, [...removed]),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(state.pendingApprovalsBySession).filter(([key]) => !removed.has(key)),
      ),
      dismissedRuntimeErrorBySession: Object.fromEntries(
        Object.entries(state.dismissedRuntimeErrorBySession).filter(([key]) => !removed.has(key)),
      ),
      foregroundHistorySessionKey: state.foregroundHistorySessionKey && removed.has(state.foregroundHistorySessionKey)
        ? null : state.foregroundHistorySessionKey,
    };
  });
}
