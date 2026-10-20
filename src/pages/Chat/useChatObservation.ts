import { useEffect, useMemo, useRef } from 'react';
import { useChatStore, type ChatStoreState } from '@/stores/chat';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import { getCronSessionBaseKey, parseCronSessionKey } from '@/stores/chat/cron-session-utils';
import { buildSessionIdentityKey, runtimeEndpointsEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { isSessionTraceEnabled, logSessionTrace, summarizeError } from '@/lib/session-trace';

function observedIdentitiesKey(state: ChatStoreState, identity: SessionIdentity | null): string {
  if (!identity) return '[]';
  const identities = new Map([[buildSessionIdentityKey(identity), identity]]);
  const cron = parseCronSessionKey(identity.sessionKey);
  if (cron && !cron.runSessionId) {
    for (const recordKey of Object.values(state.sessionRecordKeyByIdentityKey)) {
      const candidate = state.loadedSessions[recordKey]?.meta.sessionIdentity;
      if (candidate && candidate.agentId === identity.agentId
        && getCronSessionBaseKey(candidate.sessionKey) === getCronSessionBaseKey(identity.sessionKey)
        && runtimeEndpointsEqual(candidate.endpoint, identity.endpoint)) {
        identities.set(buildSessionIdentityKey(candidate), candidate);
      }
    }
  }
  return JSON.stringify([...identities].sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity));
}

function release(identity: SessionIdentity, leaseId: string) {
  void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
    console.warn('[session.release]', summarizeError(error));
    if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', () => (summarizeError(error)));
  });
}

function reportObservationError(error: unknown) {
  console.warn('[session.observe]', summarizeError(error));
  if (isSessionTraceEnabled()) logSessionTrace('session.observe.failed', 'session-observation-boundary', () => (summarizeError(error)));
}

function createObservationSelector(identity: SessionIdentity | null) {
  let previousIndex: ChatStoreState['sessionRecordKeyByIdentityKey'] | undefined;
  let key = '[]';
  return (state: ChatStoreState) => {
    if (previousIndex !== state.sessionRecordKeyByIdentityKey) {
      previousIndex = state.sessionRecordKeyByIdentityKey;
      key = observedIdentitiesKey(state, identity);
    }
    return key;
  };
}

export function useChatObservation(active: boolean, identity: SessionIdentity | null) {
  const selectIdentities = useMemo(() => createObservationSelector(identity), [identity]);
  const identitiesKey = useChatStore(selectIdentities);
  const openClawObservationsRef = useRef(new Map<string, { identity: SessionIdentity; leaseId: string }>());
  useEffect(() => {
    if (!active) return;
    const observations = (JSON.parse(identitiesKey) as SessionIdentity[])
      .filter((identity) => identity.endpoint.kind !== 'native-runtime' || identity.endpoint.runtimeAdapterId !== 'openclaw')
      .map((identity) => ({ identity, leaseId: crypto.randomUUID() }));
    for (const { identity, leaseId } of observations) {
      void useChatStore.getState().observeSession(identity, leaseId).ready.catch(reportObservationError);
    }
    return () => {
      for (const { identity, leaseId } of observations) release(identity, leaseId);
    };
  }, [active, identitiesKey]);
  useEffect(() => {
    const desired = new Map((active ? JSON.parse(identitiesKey) as SessionIdentity[] : [])
      .filter((identity) => identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw')
      .map((identity) => [buildSessionIdentityKey(identity), identity]));
    const observations = openClawObservationsRef.current;
    for (const [key, observation] of observations) {
      if (desired.has(key)) continue;
      observations.delete(key);
      release(observation.identity, observation.leaseId);
    }
    for (const [key, identity] of desired) {
      if (observations.has(key)) continue;
      const { leaseId, ready } = useChatStore.getState().observeSession(identity);
      observations.set(key, { identity, leaseId });
      void ready.catch(reportObservationError);
    }
  }, [active, identitiesKey]);
  useEffect(() => () => {
    for (const { identity, leaseId } of openClawObservationsRef.current.values()) release(identity, leaseId);
    openClawObservationsRef.current.clear();
  }, []);
  useEffect(() => {
    let previous = useChatStore.getState().loadedSessions;
    return useChatStore.subscribe((state) => {
      if (previous === state.loadedSessions) return;
      const removedKeys = Object.keys(previous).filter((key) => !(key in state.loadedSessions));
      previous = state.loadedSessions;
      for (const key of removedKeys) useComposerDraftStore.getState().clearDraft(key);
    });
  }, []);
}
