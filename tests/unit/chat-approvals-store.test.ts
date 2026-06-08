import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { SessionIdentity } from '../../runtime-host/shared/runtime-address';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const hostSessionApprovalsMock = vi.fn();
const hostSessionResolveApprovalMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionApprovals: (...args: unknown[]) => hostSessionApprovalsMock(...args),
  hostSessionRename: vi.fn(),
  hostSessionResolveApproval: (...args: unknown[]) => hostSessionResolveApprovalMock(...args),
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

function buildSessionRecord(sessionIdentity: SessionIdentity | null, backendSessionKey: string) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      backendSessionKey,
      runtimeScopeKey: sessionIdentity ? buildRuntimeScopeKey(sessionIdentity.endpoint) : null,
      sessionIdentity,
    },
  };
}

describe('chat approvals store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  it('syncs pending approvals with the target session identity', async () => {
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:test:main', 'test');
    const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
    const testRecordKey = buildSessionRecordKey(sessionIdentity);
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{
        id: 'approval-1',
        sessionKey: 'agent:test:main',
        sessionIdentity,
        title: 'Approval',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainSessionIdentity, 'agent:main:main'),
        [testRecordKey]: buildSessionRecord(sessionIdentity, 'agent:test:main'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(testRecordKey);

    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({ sessionIdentity });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [mainRecordKey]: [],
      [testRecordKey]: [expect.objectContaining({ id: 'approval-1' })],
    });
  });

  it('routes same-key approvals to the matching runtime agent record', async () => {
    const mainSessionIdentity = createOpenClawTestSessionIdentity('main', 'main');
    const browserSessionIdentity = createOpenClawTestSessionIdentity('main', 'browser');
    const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
    const browserRecordKey = buildSessionRecordKey(browserSessionIdentity);
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{
        id: 'approval-browser',
        sessionKey: 'main',
        sessionIdentity: browserSessionIdentity,
        title: 'Browser approval',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainSessionIdentity, 'main'),
        [browserRecordKey]: buildSessionRecord(browserSessionIdentity, 'main'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(browserRecordKey);

    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [mainRecordKey]: [],
      [browserRecordKey]: [expect.objectContaining({ id: 'approval-browser' })],
    });
  });

  it('resolves duplicate approval ids with the clicked session identity', async () => {
    const mainSessionIdentity = createOpenClawTestSessionIdentity('main', 'main');
    const browserSessionIdentity = createOpenClawTestSessionIdentity('main', 'browser');
    const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
    const browserRecordKey = buildSessionRecordKey(browserSessionIdentity);
    const mainApproval = {
      id: 'approval-duplicate',
      sessionKey: mainRecordKey,
      backendSessionKey: 'main',
      sessionIdentity: mainSessionIdentity,
      title: 'Main approval',
      allowedDecisions: ['allow-once' as const],
      createdAtMs: 1,
    };
    const browserApproval = {
      id: 'approval-duplicate',
      sessionKey: browserRecordKey,
      backendSessionKey: 'main',
      sessionIdentity: browserSessionIdentity,
      title: 'Browser approval',
      allowedDecisions: ['deny' as const],
      createdAtMs: 2,
    };
    hostSessionResolveApprovalMock.mockResolvedValueOnce({});
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainSessionIdentity, 'main'),
        [browserRecordKey]: buildSessionRecord(browserSessionIdentity, 'main'),
      },
      pendingApprovalsBySession: {
        [mainRecordKey]: [mainApproval],
        [browserRecordKey]: [browserApproval],
      },
    } as never);

    await useChatStore.getState().resolveApproval(browserApproval, 'deny');

    expect(hostSessionResolveApprovalMock).toHaveBeenCalledWith({
      id: 'approval-duplicate',
      sessionKey: 'main',
      sessionIdentity: browserSessionIdentity,
      decision: 'deny',
    });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [mainRecordKey]: [mainApproval],
      [browserRecordKey]: [],
    });
  });

  it('does not request pending approvals when the target session has no identity', async () => {
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
