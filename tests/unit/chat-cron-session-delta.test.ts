import { describe, expect, it } from 'vitest';
import { buildSessionIdentityKey } from '../../src/types/desktop/runtime-address';
import {
  applySessionDelta,
  applySessionView,
  createEmptySessionRecord,
  getSessionItems,
  getSessionRuntime,
} from '@/stores/chat/store-state-helpers';
import type { ChatStoreState } from '@/stores/chat/types';
import {
  completeFact,
  runtimeView,
  sessionDelta,
  sessionFixtureIdentity,
  sessionView,
} from './helpers/session-fixtures';

function createStateHarness(initialState: ChatStoreState) {
  let currentState = initialState;
  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(currentState) : partial;
    currentState = { ...currentState, ...patch } as ChatStoreState;
  };
  return {
    set,
    get: () => currentState,
  };
}

function createChatState(sessionKey: string): ChatStoreState {
  const identity = sessionFixtureIdentity(sessionKey);
  return {
    currentSessionKey: sessionKey,
    loadedSessions: {
      [sessionKey]: {
        ...createEmptySessionRecord(),
        meta: {
          ...createEmptySessionRecord().meta,
          runtimeScopeKey: JSON.stringify({
            type: 'runtime-endpoint',
            kind: 'native-runtime',
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
          }),
          agentId: identity.agentId,
          runtimeEndpointId: identity.endpoint.runtimeInstanceId,
          sessionIdentity: identity,
        },
      },
    },
    sessionRecordKeyByIdentityKey: {
      [buildSessionIdentityKey(identity)]: sessionKey,
    },
    pendingApprovalsBySession: {},
    loadHistory: async () => {},
  } as ChatStoreState;
}

describe('cron run-scoped session delta projection', () => {
  it('applies a run-scoped cron delta to the existing base cron record', () => {
    const baseSessionKey = 'agent:main:cron:job-1';
    const harness = createStateHarness(createChatState(baseSessionKey));

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(baseSessionKey, {
      epoch: 1,
      seq: 0,
      cursor: 0,
      runtime: completeFact(runtimeView({ phase: 'completed', activeRunId: null })),
    }))).toMatchObject({ status: 'applied', sessionKey: baseSessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(
      'agent:main:cron:job-1:run:run-1',
      {
        epoch: 1,
        seq: 1,
        cursor: 1,
        changes: [
          { kind: 'runPhaseChanged', runId: 'run-1', phase: 'started' },
          {
            kind: 'messageDelta',
            itemId: 'assistant-run-1',
            runId: 'run-1',
            messageId: 'message-run-1',
            text: 'live',
            replace: false,
            status: 'streaming',
          },
        ],
      },
    ));

    expect(result).toMatchObject({ status: 'applied', sessionKey: baseSessionKey });
    expect(getSessionRuntime(harness.get(), baseSessionKey)).toMatchObject({
      activeRunId: 'run-1',
      runPhase: 'streaming',
    });
    expect(getSessionItems(harness.get(), baseSessionKey)).toMatchObject([
      expect.objectContaining({ key: 'assistant-run-1', text: 'live', runId: 'run-1' }),
    ]);
    expect(harness.get().loadedSessions['agent:main:cron:job-1:run:run-1']).toBeUndefined();
  });

  it('accepts a newer epoch even when its seq restarts', () => {
    const sessionKey = 'agent:main:main';
    const harness = createStateHarness(createChatState(sessionKey));

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 9,
      cursor: 9,
      runtime: completeFact(runtimeView({ phase: 'completed', activeRunId: null })),
    }))).toMatchObject({ status: 'applied', sessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 2,
      seq: 1,
      cursor: 1,
      changes: [{ kind: 'runtimeChanged', runtime: runtimeView({ phase: 'queued', activeRunId: 'run-2' }) }],
    }));

    expect(result).toMatchObject({ status: 'applied', sessionKey, epoch: 2, seq: 1, cursor: 1 });
    expect(getSessionRuntime(harness.get(), sessionKey)).toMatchObject({
      activeRunId: 'run-2',
      runPhase: 'submitted',
    });
  });

  it('projects and clears runtime notice deltas by run lifecycle', () => {
    const sessionKey = 'agent:main:main';
    const harness = createStateHarness(createChatState(sessionKey));

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 0,
      cursor: 0,
      runtime: completeFact(runtimeView({ phase: 'started', activeRunId: 'run-1' })),
    }))).toMatchObject({ status: 'applied', sessionKey });

    expect(applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 1,
      cursor: 1,
      runId: 'run-1',
      changes: [{
        kind: 'runtimeNoticeUpdated',
        notice: {
          runId: 'run-1',
          kind: 'guardian_reviewing',
          command: 'cargo test',
          riskLevel: null,
          rationale: null,
          message: null,
        },
      }],
    }))).toMatchObject({ status: 'applied', sessionKey });
    expect(getSessionRuntime(harness.get(), sessionKey).runtimeNotice).toMatchObject({
      runId: 'run-1',
      kind: 'guardian_reviewing',
      command: 'cargo test',
    });

    expect(applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 2,
      cursor: 2,
      runId: 'run-2',
      changes: [{ kind: 'runPhaseChanged', runId: 'run-2', phase: 'started' }],
    }))).toMatchObject({ status: 'applied', sessionKey });
    expect(getSessionRuntime(harness.get(), sessionKey).runtimeNotice).toBeNull();

    expect(applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 3,
      cursor: 3,
      runId: 'run-2',
      changes: [{
        kind: 'runtimeNoticeUpdated',
        notice: {
          runId: 'run-2',
          kind: 'guardian_warning',
          command: null,
          riskLevel: 'medium',
          rationale: null,
          message: null,
        },
      }],
    }))).toMatchObject({ status: 'applied', sessionKey });

    expect(applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 4,
      cursor: 4,
      runId: 'run-2',
      changes: [{ kind: 'runPhaseChanged', runId: 'run-2', phase: 'completed' }],
    }))).toMatchObject({ status: 'applied', sessionKey });
    expect(getSessionRuntime(harness.get(), sessionKey).runtimeNotice).toBeNull();
  });

  it('projects runtime activity and safe error detail from runtimeChanged deltas', () => {
    const sessionKey = 'agent:main:main';
    const harness = createStateHarness(createChatState(sessionKey));

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 0,
      cursor: 0,
      runtime: completeFact(runtimeView({ phase: 'completed', activeRunId: null })),
    }))).toMatchObject({ status: 'applied', sessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 1,
      cursor: 1,
      changes: [{
        kind: 'runtimeChanged',
        runtime: runtimeView({
          phase: 'failed',
          activeRunId: 'run-2',
          runtimeActivity: 'compacting',
          errorDetail: {
            kind: 'fallback',
            failoverReason: 'rate_limit',
            providerRuntimeFailureKind: null,
            providerErrorType: 'overloaded',
            providerErrorMessagePreview: 'raw preview',
            httpStatus: 429,
          },
        }),
      }],
    }));

    expect(result).toMatchObject({ status: 'applied', sessionKey, epoch: 1, seq: 1, cursor: 1 });
    expect(getSessionRuntime(harness.get(), sessionKey)).toMatchObject({
      activeRunId: 'run-2',
      runPhase: 'error',
      runtimeActivity: 'compacting',
      errorDetail: {
        kind: 'fallback',
        failoverReason: 'rate_limit',
        providerErrorType: 'overloaded',
        providerErrorMessagePreview: 'raw preview',
        httpStatus: 429,
      },
    });
  });

  it('loads history when a newer epoch delta does not start from one', () => {
    const sessionKey = 'agent:main:main';
    const historyRequests: string[] = [];
    const harness = createStateHarness({
      ...createChatState(sessionKey),
      loadHistory: async (request) => {
        historyRequests.push(`${request.sessionKey}:${request.reason}`);
      },
    } as ChatStoreState);

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 9,
      cursor: 9,
    }))).toMatchObject({ status: 'applied', sessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 2,
      seq: 3,
      cursor: 3,
      changes: [{ kind: 'runtimeChanged', runtime: runtimeView({ phase: 'queued', activeRunId: 'run-2' }) }],
    }));

    expect(result).toMatchObject({ status: 'gap', sessionKey, reason: 'new epoch delta did not start at seq 1, cursor 1' });
    expect(historyRequests).toEqual(['agent:main:main:session_delta_epoch_gap']);
  });

  it('keeps same-epoch restarted seq stale', () => {
    const sessionKey = 'agent:main:main';
    const harness = createStateHarness(createChatState(sessionKey));

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 9,
      cursor: 9,
      runtime: completeFact(runtimeView({ phase: 'completed', activeRunId: null })),
    }))).toMatchObject({ status: 'applied', sessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(sessionKey, {
      epoch: 1,
      seq: 1,
      cursor: 1,
      changes: [{ kind: 'runtimeChanged', runtime: runtimeView({ phase: 'queued', activeRunId: 'run-2' }) }],
    }));

    expect(result).toMatchObject({ status: 'stale', sessionKey, epoch: 1, seq: 1, cursor: 1 });
    expect(getSessionRuntime(harness.get(), sessionKey)).toMatchObject({
      activeRunId: null,
      runPhase: 'done',
    });
  });

  it('keeps non-cron run-scoped deltas strict', () => {
    const sessionKey = 'agent:main:main';
    const historyRequests: string[] = [];
    const harness = createStateHarness({
      ...createChatState(sessionKey),
      loadHistory: async (request) => {
        historyRequests.push(request.sessionKey);
      },
    } as ChatStoreState);

    expect(applySessionView({ set: harness.set, get: harness.get }, sessionView(sessionKey, {
      epoch: 1,
      seq: 0,
      cursor: 0,
    }))).toMatchObject({ status: 'applied', sessionKey });

    const result = applySessionDelta({ set: harness.set, get: harness.get }, sessionDelta(
      'agent:main:main:run:run-1',
      {
        epoch: 1,
        seq: 1,
        cursor: 1,
        changes: [{ kind: 'runPhaseChanged', runId: 'run-1', phase: 'started' }],
      },
    ));

    expect(result).toMatchObject({ status: 'gap', sessionKey: 'agent:main:main:run:run-1' });
    expect(historyRequests).toEqual(['agent:main:main:run:run-1']);
    expect(getSessionRuntime(harness.get(), sessionKey).activeRunId).toBeNull();
  });
});
