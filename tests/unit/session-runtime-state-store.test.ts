import { describe, expect, it } from 'vitest';
import { SessionRuntimeStateStore } from '../../runtime-host/application/sessions/session-runtime-state';
import { createOpenClawTestSessionIdentity, createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

function createStore() {
  const saves: Array<{ version: 3; activeSessionKey: string | null }> = [];
  const store = new SessionRuntimeStateStore({
    runtimeStore: {
      load: async () => ({ version: 3, activeSessionKey: null }),
      save: async (payload) => {
        saves.push(payload);
      },
    },
    agentRuntimeRegistry: {
      resolveSessionContext: (sessionKey: string) => createOpenClawTestRuntimeContext(sessionKey),
    } as never,
  });
  return { store, saves };
}

describe('SessionRuntimeStateStore', () => {
  it('coalesces repeated async persist requests into one runtime store write', async () => {
    const { store, saves } = createStore();

    await store.ready();
    store.setActiveSessionKey('agent:main:one');
    store.persistStore();
    store.persistStore();
    store.persistStore();

    await store.flushPersistedStore();

    expect(saves).toEqual([{ version: 3, activeSessionKey: 'agent:main:one' }]);
  });

  it('keeps same backend sessionKey isolated across runtime agents', () => {
    const { store } = createStore();
    const mainContext = createOpenClawTestRuntimeContext('main', 'main');
    const browserContext = createOpenClawTestRuntimeContext('main', 'browser');

    const mainState = store.getSessionState('main', mainContext);
    const browserState = store.getSessionState('main', browserContext);

    mainState.runtime.activeRunId = 'run-main';
    browserState.runtime.activeRunId = 'run-browser';

    expect(mainState).not.toBe(browserState);
    expect(store.findSessionState('main', mainContext)?.runtime.activeRunId).toBe('run-main');
    expect(store.findSessionState('main', browserContext)?.runtime.activeRunId).toBe('run-browser');
    expect(() => store.findSessionState('main')).toThrow('Session state requires explicit session identity metadata: main');
  });

  it('indexes pending approvals by exact SessionIdentity within the same session key', () => {
    const { store } = createStore();
    const sessionKey = 'agent:main:approval';
    const promptIdentity = createOpenClawTestSessionIdentity(sessionKey, 'main');
    const browserIdentity = createOpenClawTestSessionIdentity(sessionKey, 'browser');
    const promptContext = createOpenClawTestRuntimeContext(sessionKey, 'main');
    const browserContext = createOpenClawTestRuntimeContext(sessionKey, 'browser');
    const promptState = store.getSessionState(sessionKey, promptContext);
    const browserState = store.getSessionState(sessionKey, browserContext);
    promptState.canonical.approvals = [{
      id: 'approval-duplicate',
      sessionKey,
      sessionIdentity: promptIdentity,
      title: 'prompt',
      allowedDecisions: ['allow-once'],
      createdAtMs: 1,
    }];
    browserState.canonical.approvals = [{
      id: 'approval-duplicate',
      sessionKey,
      sessionIdentity: browserIdentity,
      title: 'browser',
      allowedDecisions: ['deny'],
      createdAtMs: 2,
    }];

    store.syncApprovalIdentityIndex(sessionKey, promptState);
    store.syncApprovalIdentityIndex(sessionKey, browserState);

    expect(store.listApprovals(promptIdentity).map((entry) => entry.approval.id)).toEqual(['approval-duplicate']);
    expect(store.listApprovals(browserIdentity).map((entry) => entry.approval.id)).toEqual(['approval-duplicate']);
    expect(store.findApproval(promptIdentity, 'approval-duplicate')).toEqual(expect.objectContaining({
      sessionKey,
      approval: promptState.canonical.approvals[0],
    }));
    expect(store.findApproval(browserIdentity, 'approval-duplicate')).toEqual(expect.objectContaining({
      sessionKey,
      approval: browserState.canonical.approvals[0],
    }));

    browserState.canonical.approvals = [];
    store.syncApprovalIdentityIndex(sessionKey, browserState);

    expect(store.findApproval(browserIdentity, 'approval-duplicate')).toBeNull();
    expect(store.findApproval(promptIdentity, 'approval-duplicate')).toEqual(expect.objectContaining({
      approval: promptState.canonical.approvals[0],
    }));
    expect(store.listApprovals(browserIdentity)).toEqual([]);
  });

  it('replaces execution graph parent indexes without scanning unrelated children', () => {
    const { store } = createStore();
    const parentSessionKey = 'agent:main:parent';
    const parentContext = createOpenClawTestRuntimeContext(parentSessionKey, 'main');
    const firstChildIdentity = createOpenClawTestSessionIdentity('agent:main:child-1', 'main');
    const secondChildIdentity = createOpenClawTestSessionIdentity('agent:main:child-2', 'main');

    const parentState = store.getSessionState(parentSessionKey, parentContext);
    const firstChildState = store.getSessionState('agent:main:child-1', createOpenClawTestRuntimeContext('agent:main:child-1', 'main'));
    const secondChildState = store.getSessionState('agent:main:child-2', createOpenClawTestRuntimeContext('agent:main:child-2', 'main'));

    store.updateExecutionGraphDependencyIndex(parentSessionKey, parentContext, [{
      key: 'graph-1',
      kind: 'execution-graph',
      role: 'assistant',
      sessionKey: parentSessionKey,
      graphId: 'graph-1',
      completionItemKey: 'completion-1',
      childSessionKey: 'agent:main:child-1',
      childSessionIdentity: firstChildIdentity,
      agentLabel: 'main',
      sessionLabel: 'child-1',
      steps: [],
      active: true,
    }]);
    expect(store.listParentSessionStates(firstChildIdentity)).toEqual([parentState]);

    store.updateExecutionGraphDependencyIndex(parentSessionKey, parentContext, [{
      key: 'graph-2',
      kind: 'execution-graph',
      role: 'assistant',
      sessionKey: parentSessionKey,
      graphId: 'graph-2',
      completionItemKey: 'completion-2',
      childSessionKey: 'agent:main:child-2',
      childSessionIdentity: secondChildIdentity,
      agentLabel: 'main',
      sessionLabel: 'child-2',
      steps: [],
      active: true,
    }]);

    expect(firstChildState.sessionKey).toBe('agent:main:child-1');
    expect(secondChildState.sessionKey).toBe('agent:main:child-2');
    expect(store.listParentSessionStates(firstChildIdentity)).toEqual([]);
    expect(store.listParentSessionStates(secondChildIdentity)).toEqual([parentState]);
  });

  it('removes global approval id index entries when deleting a session', () => {
    const { store } = createStore();
    const sessionKey = 'agent:main:deleted-approval';
    const context = createOpenClawTestRuntimeContext(sessionKey);
    const state = store.getSessionState(sessionKey, context);
    const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey);
    state.canonical.approvals = [{
      id: 'approval-delete',
      sessionKey,
      sessionIdentity,
      title: 'approval',
      allowedDecisions: ['allow-once'],
      createdAtMs: 1,
    }];

    store.syncApprovalIdentityIndex(sessionKey, state);
    store.deleteSessionState(sessionKey, context);

    expect(store.findApproval(sessionIdentity, 'approval-delete')).toBeNull();
    expect(store.listApprovals(sessionIdentity)).toEqual([]);
  });

  it('expires transport issues through the issue session index only', async () => {
    const { store } = createStore();
    const affected = store.getSessionState('agent:main:affected');
    const unaffected = store.getSessionState('agent:main:unaffected');
    const expiredIssue = {
      source: 'runtime' as const,
      message: 'Gateway unavailable',
      code: 'UNAVAILABLE',
      retryable: true,
      at: 1,
    };
    affected.canonical.control = {
      ...affected.canonical.control,
      issue: expiredIssue,
      issueTransportEpoch: 1,
    };
    affected.canonical.runtime = {
      ...affected.canonical.runtime,
      lastError: expiredIssue.message,
      lastIssue: expiredIssue,
    };
    affected.runtime = {
      ...affected.runtime,
      lastError: expiredIssue.message,
      lastIssue: expiredIssue,
    };
    unaffected.canonical.control = {
      ...unaffected.canonical.control,
      issue: {
        source: 'runtime',
        message: 'Unindexed issue must not be scanned',
        retryable: false,
        at: 1,
      },
      issueTransportEpoch: 1,
    };

    store.syncTransportIssueIndex('agent:main:affected', affected);

    expect(store.expireTransportControlIssues(1)).toEqual(['agent:main:affected']);
    expect(affected.canonical.control.issue).toBeNull();
    expect(affected.runtime.lastIssue).toBeNull();
    expect(unaffected.canonical.control.issue?.message).toBe('Unindexed issue must not be scanned');
  });
});
