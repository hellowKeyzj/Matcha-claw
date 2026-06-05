import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

const hostSessionApprovalsMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionApprovals: (...args: unknown[]) => hostSessionApprovalsMock(...args),
  hostSessionRename: vi.fn(),
  hostSessionResolveApproval: vi.fn(),
  hostSessionAbort: vi.fn(),
  hostSessionPrompt: vi.fn(),
  hostSessionList: vi.fn(),
  hostSessionNew: vi.fn(),
  hostSessionDelete: vi.fn(),
  hostSessionResume: vi.fn(),
  hostSessionSwitch: vi.fn(),
  hostSessionWindowFetch: vi.fn(),
  waitForRuntimeJobResult: vi.fn(),
}));

function buildSessionRecord(runtimeAddress: RuntimeAddress | null, backendSessionKey: string) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      backendSessionKey,
      runtimeScopeKey: runtimeAddress ? buildRuntimeScopeKey(runtimeAddress) : null,
      runtimeAddress,
    },
  };
}

describe('chat approvals store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  it('syncs pending approvals with the target session RuntimeAddress', async () => {
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:test:main', 'test');
    const mainRuntimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    const mainRecordKey = buildSessionRecordKey(mainRuntimeAddress, 'agent:main:main');
    const testRecordKey = buildSessionRecordKey(runtimeAddress, 'agent:test:main');
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{
        id: 'approval-1',
        sessionKey: 'agent:test:main',
        runtimeAddress,
        title: 'Approval',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainRuntimeAddress, 'agent:main:main'),
        [testRecordKey]: buildSessionRecord(runtimeAddress, 'agent:test:main'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(testRecordKey);

    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({ runtimeAddress });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [mainRecordKey]: [],
      [testRecordKey]: [expect.objectContaining({ id: 'approval-1' })],
    });
  });

  it('routes same-key approvals to the matching runtime agent record', async () => {
    const mainRuntimeAddress = createOpenClawTestRuntimeAddress('main', 'main');
    const browserRuntimeAddress = createOpenClawTestRuntimeAddress('main', 'browser');
    const mainRecordKey = buildSessionRecordKey(mainRuntimeAddress, 'main');
    const browserRecordKey = buildSessionRecordKey(browserRuntimeAddress, 'main');
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{
        id: 'approval-browser',
        sessionKey: 'main',
        runtimeAddress: browserRuntimeAddress,
        title: 'Browser approval',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainRuntimeAddress, 'main'),
        [browserRecordKey]: buildSessionRecord(browserRuntimeAddress, 'main'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(browserRecordKey);

    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [mainRecordKey]: [],
      [browserRecordKey]: [expect.objectContaining({ id: 'approval-browser' })],
    });
  });

  it('does not request pending approvals when the target session has no RuntimeAddress', async () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      loadedSessions: {
        'agent:test:main': buildSessionRecord(null, 'agent:test:main'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals();

    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({});
  });
});
