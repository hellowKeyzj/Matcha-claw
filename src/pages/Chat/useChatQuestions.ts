import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hostOpenClawQuestionList, hostOpenClawQuestionResolve } from '@/lib/host-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import {
  isOpenClawQuestionSessionIdentity,
  type OpenClawPendingQuestionRecord,
} from '@/types/openclaw-question';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';

type QuestionProjection = {
  scopeKey: string;
  questions: OpenClawPendingQuestionRecord[];
  confirmed: boolean;
  error: string | null;
  submittingId: string | null;
};

type QuestionLane = {
  scopeKey: string;
  refresh: () => void;
  resolve: (id: string, answers: Record<string, string[]>) => Promise<void>;
};

const EMPTY_PROJECTION: QuestionProjection = {
  scopeKey: '', questions: [], confirmed: false, error: null, submittingId: null,
};

export function useChatQuestions(
  sessionIdentity: SessionIdentity | null | undefined,
  active: boolean,
  ready: boolean,
  recoveryKey: string,
) {
  const scopeKey = active && isOpenClawQuestionSessionIdentity(sessionIdentity)
    ? buildSessionIdentityKey(sessionIdentity)
    : '';
  const identity = useMemo(() => scopeKey ? sessionIdentity : null, [scopeKey]);
  const currentScope = useRef(scopeKey);
  const runtimeReady = useRef(ready);
  currentScope.current = scopeKey;
  runtimeReady.current = ready;
  const lane = useRef<QuestionLane | null>(null);
  const [projection, setProjection] = useState(EMPTY_PROJECTION);

  useEffect(() => {
    if (!identity || !scopeKey) {
      lane.current = null;
      setProjection(EMPTY_PROJECTION);
      return;
    }
    let live = true;
    let inFlight = false;
    let dirty = false;
    let revision = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let state: QuestionProjection = { ...EMPTY_PROJECTION, scopeKey };
    const isCurrent = () => live && currentScope.current === scopeKey;
    const publish = (patch: Partial<QuestionProjection>) => {
      if (!isCurrent()) return;
      state = { ...state, ...patch };
      setProjection(state);
    };
    const scheduleDeadline = () => {
      clearTimeout(deadline);
      const now = Date.now();
      const next = state.questions.reduce((earliest, question) => (
        question.expiresAtMs > now ? Math.min(earliest, question.expiresAtMs) : earliest
      ), Infinity);
      if (Number.isFinite(next)) {
        deadline = setTimeout(refresh, Math.min(next - now, 2_147_483_647));
      }
    };
    const read = async () => {
      if (!isCurrent() || !runtimeReady.current || inFlight || state.submittingId) return;
      inFlight = true;
      dirty = false;
      const readRevision = revision;
      try {
        const result = await hostOpenClawQuestionList({ sessionIdentity: identity });
        if (isCurrent() && runtimeReady.current && revision === readRevision) {
          publish({
            questions: result.questions.filter((question) => (
              question.agentId === identity.agentId && question.sessionKey === identity.sessionKey
            )),
            confirmed: true,
            error: null,
          });
          scheduleDeadline();
        }
      } catch {
        if (isCurrent() && revision === readRevision) {
          publish({ confirmed: false, error: '无法确认待答问题，请重试' });
        }
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
    const resolve = async (id: string, answers: Record<string, string[]>) => {
      const record = state.questions.find((question) => question.id === id);
      if (!isCurrent() || !runtimeReady.current || !state.confirmed || state.submittingId
        || !record || record.expiresAtMs <= Date.now()) {
        throw new Error('Question is not confirmed pending');
      }
      revision += 1;
      dirty = true;
      publish({ submittingId: id, confirmed: false, error: null });
      try {
        await hostOpenClawQuestionResolve({
          sessionIdentity: identity,
          id,
          answers: { answers },
          resolvedBy: 'matchaclaw',
        });
        revision += 1;
        publish({ questions: state.questions.filter((question) => question.id !== id) });
      } finally {
        if (isCurrent()) {
          publish({ submittingId: null });
          refresh();
        }
      }
    };
    lane.current = { scopeKey, refresh, resolve };
    publish({});
    const unsubscribeHint = subscribeHostEvent('openclaw:questions-changed', refresh);
    const unsubscribeRecovery = subscribeBrowserRecovery(refresh);
    return () => {
      live = false;
      clearTimeout(deadline);
      unsubscribeHint();
      unsubscribeRecovery();
      if (lane.current?.scopeKey === scopeKey) lane.current = null;
    };
  }, [identity, scopeKey]);

  useEffect(() => {
    lane.current?.refresh();
  }, [ready, recoveryKey, scopeKey]);

  const refresh = useCallback(() => {
    if (lane.current?.scopeKey === scopeKey) lane.current.refresh();
  }, [scopeKey]);
  const resolve = useCallback(async (id: string, answers: Record<string, string[]>) => {
    if (!scopeKey || lane.current?.scopeKey !== scopeKey) {
      throw new Error('Question scope changed');
    }
    await lane.current.resolve(id, answers);
  }, [scopeKey]);
  const current = projection.scopeKey === scopeKey ? projection : EMPTY_PROJECTION;
  return { ...current, scopeKey, confirmed: current.confirmed && ready, refresh, resolve };
}
