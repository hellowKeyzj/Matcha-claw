import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hostCapabilityDescribe, hostSessionQuestionList, hostSessionQuestionRespond } from '@/lib/host-api';
import { subscribeBrowserRecovery } from '@/lib/host-events';
import { useChatStore } from '@/stores/chat';
import { getSessionProjectionWatermark } from '@/stores/chat/store-state-helpers';
import { buildSessionIdentityKey, sessionScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import { isSessionQuestionIdentity, type SessionQuestionAnswer, type SessionQuestionTarget, type SessionQuestionView } from '@/types/session-question';

type Projection = { scopeKey: string; questions: SessionQuestionView[]; confirmed: boolean; error: string | null; submittingId: string | null };
const EMPTY: Projection = { scopeKey: '', questions: [], confirmed: false, error: null, submittingId: null };
export function sessionQuestionKey(target: SessionQuestionTarget): string {
  return JSON.stringify([target.sessionId, target.instanceId, target.nativeRequestId]);
}
export function useSessionQuestions(identityInput: SessionIdentity | null | undefined, endpointSessionId: string | null | undefined,
  active: boolean, ready: boolean, recoveryKey: string) {
  const scopeKey = active && isSessionQuestionIdentity(identityInput) && endpointSessionId
    ? JSON.stringify([buildSessionIdentityKey(identityInput), endpointSessionId]) : '';
  const identity = useMemo(() => scopeKey ? identityInput : null, [scopeKey]);
  const currentScope = useRef(scopeKey);
  const runtimeReady = useRef(ready);
  currentScope.current = scopeKey;
  runtimeReady.current = ready;
  const [projection, setProjection] = useState(EMPTY);
  const lane = useRef<{ scopeKey: string; refresh: () => void; respond: (target: SessionQuestionTarget, answer: SessionQuestionAnswer) => Promise<void> } | null>(null);
  useEffect(() => {
    if (!identity || !scopeKey || !endpointSessionId) {
      lane.current = null;
      setProjection(EMPTY);
      return;
    }
    let live = true;
    let inFlight = false;
    let dirty = false;
    let revision = 0;
    let state: Projection = { ...EMPTY, scopeKey };
    const isCurrent = () => live && currentScope.current === scopeKey;
    const publish = (patch: Partial<Projection>) => {
      if (!isCurrent()) return;
      state = { ...state, ...patch };
      setProjection(state);
    };
    const read = async () => {
      if (!isCurrent() || !runtimeReady.current || inFlight || state.submittingId) return;
      inFlight = true;
      dirty = false;
      const readRevision = revision;
      try {
        const { capability } = await hostCapabilityDescribe({ id: 'session.question', scope: sessionScope(identity) });
        if (!isCurrent() || revision !== readRevision || !runtimeReady.current) return;
        if (capability.availability !== 'available' || !['sessions.questions.list', 'sessions.questions.respond'].every(
          (id) => capability.operations.some((operation) => operation.id === id))) {
          publish({ questions: [], confirmed: false, error: null });
          return;
        }
        const result = await hostSessionQuestionList({ sessionIdentity: identity, endpointSessionId });
        if (!isCurrent() || revision !== readRevision || !runtimeReady.current) return;
        if (result.outcome !== 'listed') {
          publish({ confirmed: false, error: result.outcome === 'unsupported' ? null : result.outcome });
          return;
        }
        publish({ questions: result.questions.filter((question) => question.target.sessionId === endpointSessionId), confirmed: true, error: null });
      } catch {
        if (isCurrent() && revision === readRevision) publish({ confirmed: false, error: 'questions.loadFailed' });
      } finally {
        inFlight = false;
        if (dirty) void read();
      }
    };
    function refresh() {
      if (!isCurrent()) return;
      revision += 1;
      dirty = true;
      publish({ confirmed: false });
      void read();
    }
    const respond = async (target: SessionQuestionTarget, answer: SessionQuestionAnswer) => {
      const key = sessionQuestionKey(target);
      const record = state.questions.find((question) => sessionQuestionKey(question.target) === key);
      if (!isCurrent() || !runtimeReady.current || !state.confirmed || state.submittingId
        || !record || record.availability !== 'pending' || record.delivery !== 'notSent') throw new Error('Question is not confirmed pending');
      revision += 1;
      dirty = true;
      publish({ submittingId: key, confirmed: false, error: null });
      try {
        const result = await hostSessionQuestionRespond({ sessionIdentity: identity, target, answer });
        if (!isCurrent()) return;
        if ('receipt' in result && result.receipt) {
          const receipt = result.receipt;
          if (sessionQuestionKey(receipt.target) !== key) throw new Error('Question response target changed');
          publish({ questions: state.questions.map((question) => sessionQuestionKey(question.target) === key ? { ...question, ...receipt } : question) });
        }
        if (result.outcome !== 'responded') throw new Error(result.outcome);
      } finally {
        if (isCurrent()) { publish({ submittingId: null }); refresh(); }
      }
    };
    lane.current = { scopeKey, refresh, respond };
    publish({});
    const unsubscribe = subscribeBrowserRecovery(refresh);
    let watermark = getSessionProjectionWatermark(useChatStore.getState, identity);
    const unsubscribeSession = useChatStore.subscribe(() => {
      const next = getSessionProjectionWatermark(useChatStore.getState, identity);
      if (next !== watermark) { watermark = next; refresh(); }
    });
    return () => { live = false; unsubscribe(); unsubscribeSession(); if (lane.current?.scopeKey === scopeKey) lane.current = null; };
  }, [endpointSessionId, identity, scopeKey]);
  useEffect(() => { lane.current?.refresh(); }, [ready, recoveryKey, scopeKey]);
  const refresh = useCallback(() => { if (lane.current?.scopeKey === scopeKey) lane.current.refresh(); }, [scopeKey]);
  const respond = useCallback(async (target: SessionQuestionTarget, answer: SessionQuestionAnswer) => {
    if (!scopeKey || lane.current?.scopeKey !== scopeKey) throw new Error('Question scope changed');
    await lane.current.respond(target, answer);
  }, [scopeKey]);
  const current = projection.scopeKey === scopeKey ? projection : EMPTY;
  return { ...current, scopeKey, confirmed: current.confirmed && ready, refresh, respond };
}
