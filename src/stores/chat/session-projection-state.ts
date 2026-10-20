import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import type { SessionFact, SessionView } from '../../types/session/snapshot';
import type { ChatSessionRuntimeState, ChatStoreState } from './types';
import type { SessionRenderProjectionCache } from './session-render-projection';
import { getCronSessionBaseKey } from './cron-session-utils';

export type SessionProjectionState = Omit<SessionView, 'modelState'> & {
  runtimeNotice?: ChatSessionRuntimeState['runtimeNotice'] | null;
  retiredItemIds?: ReadonlySet<string>;
  recordKey?: string;
};

type ProjectionOwner = {
  canonical: Map<string, SessionProjectionState>;
  windows: Map<string, SessionProjectionState>;
  rendered: Map<string, SessionRenderProjectionCache>;
};

// The store getter is the lifetime owner; no strong registry retains discarded stores.
const projectionsByStore = new WeakMap<() => ChatStoreState, ProjectionOwner>();

function projectionOwner(get: () => ChatStoreState): ProjectionOwner {
  let owner = projectionsByStore.get(get);
  if (!owner) {
    owner = { canonical: new Map(), windows: new Map(), rendered: new Map() };
    projectionsByStore.set(get, owner);
  }
  return owner;
}

export function factValue<T>(fact: SessionFact<T>): T | null {
  if (fact === 'unknown' || fact === 'unavailable') return null;
  return 'complete' in fact ? fact.complete : fact.incomplete.facts;
}

export function projectionStore(get: () => ChatStoreState): Map<string, SessionProjectionState> {
  return projectionOwner(get).canonical;
}

export function windowStore(get: () => ChatStoreState): Map<string, SessionProjectionState> {
  return projectionOwner(get).windows;
}

export function renderProjectionStore(get: () => ChatStoreState): Map<string, SessionRenderProjectionCache> {
  return projectionOwner(get).rendered;
}

export function getSessionProjectionWatermark(get: () => ChatStoreState, identity: SessionIdentity): string | null {
  const projection = projectionsByStore.get(get)?.canonical.get(buildSessionIdentityKey(identity));
  return projection ? `${projection.epoch}:${projection.seq}:${projection.cursor}` : null;
}

export function getSessionWindowCacheStats(get: () => ChatStoreState): { cachedSessionCount: number; cachedItemCount: number } {
  const windows = projectionsByStore.get(get)?.windows;
  let cachedItemCount = 0;
  if (windows) for (const view of windows.values()) cachedItemCount += factValue(view.items)?.length ?? 0;
  return { cachedSessionCount: windows?.size ?? 0, cachedItemCount };
}

export function resetSessionProjection(get: () => ChatStoreState, sessionKey: string): void {
  const owner = projectionsByStore.get(get);
  if (!owner) return;
  for (const store of [owner.canonical, owner.windows]) {
    const identities = new Set([...store].filter(([key, view]) => key === sessionKey || view.recordKey === sessionKey)
      .map(([, view]) => buildSessionIdentityKey(view.identity)));
    for (const [key, view] of store) {
      const identityKey = buildSessionIdentityKey(view.identity);
      const baseKey = getCronSessionBaseKey(view.identity.sessionKey);
      const baseIdentityKey = baseKey ? buildSessionIdentityKey({ ...view.identity, sessionKey: baseKey }) : null;
      if (key === sessionKey || view.recordKey === sessionKey || identityKey === sessionKey
        || identities.has(identityKey) || baseIdentityKey === sessionKey
        || baseIdentityKey !== null && identities.has(baseIdentityKey)) {
        store.delete(key);
        owner.rendered.delete(key);
      }
    }
  }
  owner.rendered.delete(sessionKey);
}
