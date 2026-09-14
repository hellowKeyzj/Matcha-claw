import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeForgetAgentSessions,
  executeLoadSessions,
  executeReconcileAgentSessionTombstones,
} from '@/stores/chat/session-actions';
import { handleStoreSessionUpdateEvent } from '@/stores/chat/event-actions';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildCurrentConversationFromSessionRecord, buildSessionRuntimeGraph } from '@/stores/chat/session-runtime-graph';
import { buildRuntimeScopeKey, buildSessionIdentityRecordIndex, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatSession, ChatSessionRecord, ChatStoreState } from '@/stores/chat/types';
import type { SessionStateSnapshot } from '@/types/session/snapshot';
import type { SessionUpdateEvent } from '@/types/session/update-event';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const hostSessionListMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionDelete: vi.fn(),
  hostSessionList: (...args: unknown[]) => hostSessionListMock(...args),
  hostSessionLoad: vi.fn(),
  hostSessionNew: vi.fn(),
}));

function createHistoryRuntimeHarness(): StoreHistoryCache {
  let runId = 0;
  return {
    getHistoryLoadRunId: () => runId,
    nextHistoryLoadRunId: () => {
      runId += 1;
      return runId;
    },
    replaceHistoryLoadAbortController: () => null,
    clearHistoryLoadAbortController: () => {},
    setHistoryLoadInFlight: () => {},
    clearHistoryLoadInFlight: () => {},
    historyFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createRuntimeCatalog() {
  const mainScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' };
  const workerScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'worker' };
  return {
    status: 'ready' as const,
    error: null,
    endpoints: [{
      endpointId: 'openclaw-default',
      protocolId: 'openclaw',
      endpoint: openClawTestRuntimeEndpoint,
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'default',
      displayName: 'OpenClaw',
      agentIds: ['main', 'worker'],
      acceptsDynamicAgents: true,
      agentCatalog: {
        source: 'runtime-endpoint' as const,
        agents: [{ id: 'main' }, { id: 'worker' }],
      },
      sessionPromptScopes: [mainScope, workerScope],
      defaultSessionPromptScope: mainScope,
    }],
    defaultSessionPromptScope: mainScope,
  };
}

function createSessionRecord(rawSessionKey: string, agentId: string): { key: string; record: ChatSessionRecord; session: ChatSession } {
  const identity = createOpenClawTestSessionIdentity(rawSessionKey, agentId);
  const key = buildSessionRecordKey(identity);
  const base = createEmptySessionRecord();
  const record = {
    ...base,
    meta: {
      ...base.meta,
      runtimeScopeKey: buildRuntimeScopeKey(identity.endpoint),
      agentId,
      protocolId: 'openclaw',
      runtimeEndpointId: 'openclaw-default',
      sessionIdentity: identity,
      kind: rawSessionKey.endsWith(':main') ? 'main' as const : 'session' as const,
      preferred: rawSessionKey.endsWith(':main'),
      titleSource: 'none' as const,
    },
  };
  return {
    key,
    record,
    session: {
      key: rawSessionKey,
      agentId,
      protocolId: 'openclaw',
      runtimeEndpointId: 'openclaw-default',
      sessionIdentity: identity,
      kind: record.meta.kind ?? 'session',
      preferred: record.meta.preferred,
      titleSource: 'none',
    },
  };
}

function createStateHarness(input: Partial<ChatStoreState> = {}) {
  const loadedSessions = input.loadedSessions ?? {};
  let state = {
    currentSessionKey: '',
    currentConversation: null,
    lastSelectedSessionKeyByRuntimeScopeKey: {},
    sessionRuntimeCatalog: createRuntimeCatalog(),
    sessionRuntimeGraph: buildSessionRuntimeGraph(createRuntimeCatalog(), loadedSessions),
    sessionCatalogLoadedAtByRuntimeScopeKey: {},
    sessionCatalogLoadedRevisionByRuntimeScopeKey: {},
    loadedSessions,
    sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
    pendingApprovalsBySession: {},
    dismissedRuntimeErrorBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: {
      status: 'idle' as const,
      error: null,
      hasLoadedOnce: false,
      lastLoadedAt: null,
    },
    mutating: false,
    error: null,
    showThinking: true,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    ...input,
  } as ChatStoreState;

  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };

  return {
    set,
    get: () => state,
  };
}

function createSessionActionsInput(harness: ReturnType<typeof createStateHarness>, historyRuntime = createHistoryRuntimeHarness()) {
  return {
    set: harness.set,
    get: harness.get,
    beginMutating: vi.fn(),
    finishMutating: vi.fn(),
    historyRuntime,
  };
}

function createSnapshot(rawSessionKey: string, agentId: string): SessionStateSnapshot {
  const identity = createOpenClawTestSessionIdentity(rawSessionKey, agentId);
  return {
    sessionKey: rawSessionKey,
    catalog: {
      key: rawSessionKey,
      agentId,
      protocolId: 'openclaw',
      runtimeEndpointId: 'openclaw-default',
      sessionIdentity: identity,
      kind: 'session',
      preferred: false,
      titleSource: 'none',
    },
    items: [],
    approvals: [],
    usage: [],
    artifacts: [],
    replayComplete: true,
    runtime: { runPhase: 'done' } as never,
    window: {
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

describe('chat session management', () => {
  beforeEach(() => {
    hostSessionListMock.mockReset();
    useComposerDraftStore.setState({ drafts: {}, selections: {} });
    executeReconcileAgentSessionTombstones(['main', 'worker', 'ghost']);
  });

  it('forgets all sessions and cached state owned by the deleted agent', () => {
    const main = createSessionRecord('agent:main:main', 'main');
    const workerMain = createSessionRecord('agent:worker:main', 'worker');
    const workerSession = createSessionRecord('agent:worker:session-1', 'worker');
    const loadedSessions = {
      [main.key]: main.record,
      [workerMain.key]: workerMain.record,
      [workerSession.key]: workerSession.record,
    };
    const runtimeScopeKey = buildRuntimeScopeKey(openClawTestRuntimeEndpoint);
    const harness = createStateHarness({
      currentSessionKey: workerMain.key,
      currentConversation: buildCurrentConversationFromSessionRecord(workerMain.record),
      lastSelectedSessionKeyByRuntimeScopeKey: {
        [runtimeScopeKey]: workerSession.key,
      },
      loadedSessions,
      sessionRuntimeGraph: buildSessionRuntimeGraph(createRuntimeCatalog(), loadedSessions),
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: {
        [workerMain.key]: [{} as never],
      },
      dismissedRuntimeErrorBySession: {
        [workerSession.key]: { updatedAt: 1, fingerprint: 'error' },
      },
      foregroundHistorySessionKey: workerSession.key,
    });
    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.historyFingerprintBySession.set(workerMain.key, 'history-main');
    historyRuntime.historyFingerprintBySession.set(workerSession.key, 'history-session');
    historyRuntime.historyRenderFingerprintBySession.set(workerMain.key, 'render-main');
    historyRuntime.historyRenderFingerprintBySession.set(workerSession.key, 'render-session');
    useComposerDraftStore.getState().setDraft(workerSession.key, 'session draft');
    useComposerDraftStore.getState().setDraft('runtime:agent:worker:draft', 'draft conversation');
    useComposerDraftStore.getState().setDraft('runtime:agent:worker2:draft', 'surviving draft');

    executeForgetAgentSessions(createSessionActionsInput(harness, historyRuntime), 'worker');

    expect(harness.get().loadedSessions[workerMain.key]).toBeUndefined();
    expect(harness.get().loadedSessions[workerSession.key]).toBeUndefined();
    expect(harness.get().loadedSessions[main.key]).toBeDefined();
    expect(harness.get().sessionRecordKeyByIdentityKey).toEqual(buildSessionIdentityRecordIndex({ [main.key]: main.record }));
    expect(harness.get().pendingApprovalsBySession).toEqual({});
    expect(harness.get().dismissedRuntimeErrorBySession).toEqual({});
    expect(harness.get().lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey]).toBe(main.key);
    expect(harness.get().currentSessionKey).toBe(main.key);
    expect(harness.get().currentConversation?.agentId).toBe('main');
    expect(harness.get().foregroundHistorySessionKey).toBeNull();
    expect(historyRuntime.historyFingerprintBySession.has(workerMain.key)).toBe(false);
    expect(historyRuntime.historyFingerprintBySession.has(workerSession.key)).toBe(false);
    expect(historyRuntime.historyRenderFingerprintBySession.has(workerMain.key)).toBe(false);
    expect(historyRuntime.historyRenderFingerprintBySession.has(workerSession.key)).toBe(false);
    expect(useComposerDraftStore.getState().drafts).toEqual({
      'runtime:agent:worker2:draft': 'surviving draft',
    });
  });

  it('clears draft conversations even when no loaded session exists for the deleted agent', () => {
    const harness = createStateHarness();
    useComposerDraftStore.getState().setDraft('runtime:agent:ghost:draft', 'draft conversation');

    executeForgetAgentSessions(createSessionActionsInput(harness), 'ghost');

    expect(useComposerDraftStore.getState().drafts).toEqual({});
  });

  it('filters stale sessions.list rows for a tombstoned agent', async () => {
    const main = createSessionRecord('agent:main:main', 'main');
    const worker = createSessionRecord('agent:worker:main', 'worker');
    const harness = createStateHarness();
    const actionsInput = createSessionActionsInput(harness);
    executeForgetAgentSessions(actionsInput, 'worker');
    hostSessionListMock.mockResolvedValueOnce({
      ready: true,
      sessions: [worker.session, main.session],
    });

    await executeLoadSessions(actionsInput);

    expect(Object.keys(harness.get().loadedSessions)).toEqual([main.key]);
    expect(Object.values(harness.get().loadedSessions).map((record) => record.meta.sessionIdentity?.agentId)).toEqual(['main']);
  });

  it('drops delayed session update events for a tombstoned agent before reporting them', () => {
    const main = createSessionRecord('agent:main:main', 'main');
    const harness = createStateHarness({
      currentSessionKey: main.key,
      currentConversation: buildCurrentConversationFromSessionRecord(main.record),
      loadedSessions: { [main.key]: main.record },
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex({ [main.key]: main.record }),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    });
    executeForgetAgentSessions(createSessionActionsInput(harness), 'worker');
    const reportSpy = vi.spyOn(useTaskSnapshotStore.getState(), 'reportSessionUpdate');

    handleStoreSessionUpdateEvent({
      set: harness.set,
      get: harness.get,
    }, {
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:worker:main',
      runId: 'run-1',
      phase: 'started',
      snapshot: createSnapshot('agent:worker:main', 'worker'),
      error: null,
    } as SessionUpdateEvent);

    expect(reportSpy).not.toHaveBeenCalled();
    expect(harness.get().loadSessions).not.toHaveBeenCalled();
    reportSpy.mockRestore();
  });
});
