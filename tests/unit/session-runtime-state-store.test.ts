import { describe, expect, it } from 'vitest';
import { SessionRuntimeStateStore } from '../../runtime-host/application/sessions/session-runtime-state';
import { createOpenClawTestRuntimeAddress, createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

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
    expect(() => store.findSessionState('main')).toThrow('Session state requires explicit runtime address metadata: main');
  });

  it('indexes pending approvals by exact RuntimeAddress within the same session', () => {
    const { store } = createStore();
    const sessionKey = 'agent:main:approval';
    const state = store.getSessionState(sessionKey);
    const promptAddress = createOpenClawTestRuntimeAddress(sessionKey);
    const approvalAddress = {
      ...promptAddress,
      capabilityId: 'session.approval',
    };
    state.canonical.approvals = [{
      id: 'approval-prompt',
      sessionKey,
      runtimeAddress: promptAddress,
      title: 'prompt',
      allowedDecisions: ['allow-once'],
      createdAtMs: 1,
    }, {
      id: 'approval-approval',
      sessionKey,
      runtimeAddress: approvalAddress,
      title: 'approval',
      allowedDecisions: ['deny'],
      createdAtMs: 2,
    }];

    store.syncApprovalAddressIndex(sessionKey, state);

    expect(store.listApprovals(promptAddress).map((entry) => entry.approval.id)).toEqual(['approval-prompt']);
    expect(store.listApprovals(approvalAddress).map((entry) => entry.approval.id)).toEqual(['approval-approval']);
    expect(store.findApproval('approval-approval')).toEqual(expect.objectContaining({
      sessionKey,
      approval: state.canonical.approvals[1],
    }));

    state.canonical.approvals = state.canonical.approvals.filter((approval) => approval.id !== 'approval-approval');
    store.syncApprovalAddressIndex(sessionKey, state);

    expect(store.findApproval('approval-approval')).toBeNull();
    expect(store.listApprovals(approvalAddress)).toEqual([]);
  });

  it('removes global approval id index entries when deleting a session', () => {
    const { store } = createStore();
    const sessionKey = 'agent:main:deleted-approval';
    const state = store.getSessionState(sessionKey);
    const runtimeAddress = createOpenClawTestRuntimeAddress(sessionKey);
    state.canonical.approvals = [{
      id: 'approval-delete',
      sessionKey,
      runtimeAddress,
      title: 'approval',
      allowedDecisions: ['allow-once'],
      createdAtMs: 1,
    }];

    store.syncApprovalAddressIndex(sessionKey, state);
    store.deleteSessionState(sessionKey);

    expect(store.findApproval('approval-delete')).toBeNull();
    expect(store.listApprovals(runtimeAddress)).toEqual([]);
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
