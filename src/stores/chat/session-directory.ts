import { buildSessionIdentityKey } from '../../types/desktop/runtime-address';
import { buildSessionIdentityRecordIndex } from './session-identity';
import { buildSessionRuntimeGraph } from './session-runtime-graph';
import type { ChatSessionRecord, ChatStoreState } from './types';

type SessionDirectoryState = Pick<ChatStoreState,
  'loadedSessions' | 'sessionRuntimeCatalog' | 'sessionRuntimeGraph' | 'sessionRecordKeyByIdentityKey'>;

function sameDirectoryRecord(left: ChatSessionRecord | undefined, right: ChatSessionRecord | undefined): boolean {
  if (left === right) return true;
  const before = left?.meta;
  const after = right?.meta;
  if (!before?.sessionIdentity || !after?.sessionIdentity) {
    return !before?.sessionIdentity && !after?.sessionIdentity;
  }
  return before.sessionIdentity === after.sessionIdentity
    && before.endpointSessionId === after.endpointSessionId
    && before.ownership === after.ownership
    && before.kind === after.kind
    && before.preferred === after.preferred
    && before.label === after.label
    && before.titleSource === after.titleSource
    && (before.displayName ?? null) === (after.displayName ?? null)
    && before.modelState === after.modelState
    && before.thinkingLevel === after.thinkingLevel
    && before.lastActivityAt === after.lastActivityAt
    && left?.contextTokens === right?.contextTokens;
}

export function reconcileSessionDirectory(
  state: SessionDirectoryState,
  loadedSessions: ChatStoreState['loadedSessions'],
  changedRecordKeys?: readonly string[],
): Pick<ChatStoreState, 'sessionRuntimeGraph' | 'sessionRecordKeyByIdentityKey'> {
  let graphChanged = false;
  let identityChanged = false;
  if (state.loadedSessions !== loadedSessions) {
    const beforeKeys = changedRecordKeys ?? Object.keys(state.loadedSessions).filter((key) => state.loadedSessions[key].meta.sessionIdentity);
    const afterKeys = changedRecordKeys ?? Object.keys(loadedSessions).filter((key) => loadedSessions[key].meta.sessionIdentity);
    for (let index = 0; index < Math.max(beforeKeys.length, afterKeys.length); index += 1) {
      const beforeKey = beforeKeys[index];
      const afterKey = afterKeys[index];
      const before = beforeKey === undefined ? undefined : state.loadedSessions[beforeKey];
      const after = afterKey === undefined ? undefined : loadedSessions[afterKey];
      if (!graphChanged && !sameDirectoryRecord(before, after)) graphChanged = true;
      if (identityChanged) continue;
      const oldIdentity = before?.meta.sessionIdentity;
      const newIdentity = after?.meta.sessionIdentity;
      if (beforeKey === afterKey && oldIdentity === newIdentity) continue;
      if (beforeKey !== afterKey || (oldIdentity ? buildSessionIdentityKey(oldIdentity) : null)
        !== (newIdentity ? buildSessionIdentityKey(newIdentity) : null)) identityChanged = true;
    }
  }
  let sessionRecordKeyByIdentityKey = state.sessionRecordKeyByIdentityKey;
  if (identityChanged) {
    const nextIndex = buildSessionIdentityRecordIndex(loadedSessions);
    const keys = Object.keys(nextIndex);
    if (keys.length !== Object.keys(sessionRecordKeyByIdentityKey).length
      || keys.some((key) => nextIndex[key] !== sessionRecordKeyByIdentityKey[key])) {
      sessionRecordKeyByIdentityKey = nextIndex;
    }
  }
  return {
    sessionRuntimeGraph: graphChanged
      ? buildSessionRuntimeGraph(state.sessionRuntimeCatalog, loadedSessions, state.sessionRuntimeGraph)
      : state.sessionRuntimeGraph,
    sessionRecordKeyByIdentityKey,
  };
}
