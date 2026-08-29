import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { ApprovalItem } from '@/stores/chat/types';
import type { SessionIdentity } from '../../electron/desktop-contract/runtime-address';

function createMatchaAgentTestSessionIdentity(
  sessionKey = 'agent:main:main',
  agentId = 'default',
): SessionIdentity {
  return {
    endpoint: {
      kind: 'native-runtime',
      runtimeAdapterId: 'matcha-agent',
      runtimeInstanceId: 'local',
    },
    agentId,
    sessionKey,
  };
}

const hostSessionApprovalsMock = vi.fn();
const hostSessionResolveApprovalMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionApprovals: (...args: unknown[]) => hostSessionApprovalsMock(...args),
  hostSessionResolveApproval: (...args: unknown[]) => hostSessionResolveApprovalMock(...args),
  hostSessionAbort: vi.fn(),
  hostSessionSend: vi.fn(),
  hostSessionList: vi.fn(),
  hostSessionNew: vi.fn(),
  hostSessionDelete: vi.fn(),
  hostSessionWindowFetch: vi.fn(),
}));

function buildSessionRecord(sessionIdentity: SessionIdentity | null, endpointSessionId?: string) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      endpointSessionId: endpointSessionId ?? null,
      runtimeScopeKey: sessionIdentity ? buildRuntimeScopeKey(sessionIdentity.endpoint) : null,
      sessionIdentity,
    },
  };
}

function approvalItem(sessionIdentity: SessionIdentity, recordKey: string): ApprovalItem {
  return {
    id: 'approval-1',
    sessionKey: recordKey,
    endpointSessionId: 'native-session-1',
    sessionIdentity,
    title: 'Approval required',
    allowedDecisions: ['allow-once'],
    createdAtMs: 1,
  };
}

describe('chat approvals store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  it('projects only opaque Matcha approval identifiers from the native snapshot', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{
        id: 'approval-1',
        sessionKey: 'agent:test:main',
        sessionIdentity,
        title: 'Approval required',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(recordKey);

    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({
      sessionIdentity,
      endpointSessionId: 'native-session-1',
    });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [recordKey]: [{
        id: 'approval-1',
        sessionKey: recordKey,
        endpointSessionId: 'native-session-1',
        sessionIdentity,
        title: 'Approval required',
        allowedDecisions: ['allow-once'],
        createdAtMs: 1,
      }],
    });
  });

  it('syncs only the requested session approvals', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const otherSessionIdentity = createMatchaAgentTestSessionIdentity('agent:other:main', 'test');
    const otherRecordKey = buildSessionRecordKey(otherSessionIdentity);
    const otherApproval = approvalItem(otherSessionIdentity, otherRecordKey);
    hostSessionApprovalsMock.mockResolvedValueOnce({ approvals: [] });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
        [otherRecordKey]: buildSessionRecord(otherSessionIdentity, 'native-session-2'),
      },
      pendingApprovalsBySession: { [otherRecordKey]: [otherApproval] },
    } as never);

    await useChatStore.getState().syncPendingApprovals(recordKey);

    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({
      sessionIdentity,
      endpointSessionId: 'native-session-1',
    });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [otherRecordKey]: [otherApproval],
      [recordKey]: [],
    });
  });

  it('resolves approval through the identity-bound API and removes the local pending receipt', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('main', 'main');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = approvalItem(sessionIdentity, recordKey);
    hostSessionResolveApprovalMock.mockResolvedValueOnce({ outcome: 'responded' });
    hostSessionApprovalsMock.mockResolvedValueOnce({ approvals: [approval] });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval(approval, 'allow-once');

    expect(hostSessionResolveApprovalMock).toHaveBeenCalledWith({
      id: 'approval-1',
      sessionKey: 'main',
      endpointSessionId: 'native-session-1',
      sessionIdentity,
      decision: 'allow-once',
    });
    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [] });
  });

  it('ignores cross-session approvals without delivery or local changes', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const otherSessionIdentity = createMatchaAgentTestSessionIdentity('agent:other:main', 'test');
    const otherRecordKey = buildSessionRecordKey(otherSessionIdentity);
    const approval = approvalItem(sessionIdentity, recordKey);
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval({ ...approval, sessionKey: otherRecordKey, sessionIdentity: otherSessionIdentity }, 'allow-once');

    expect(hostSessionResolveApprovalMock).not.toHaveBeenCalled();
    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });

  it('ignores approval identity mismatches without deleting the real receipt', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = approvalItem(sessionIdentity, recordKey);
    const forgedIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'other-agent');
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval({ ...approval, sessionIdentity: forgedIdentity }, 'allow-once');

    expect(hostSessionResolveApprovalMock).not.toHaveBeenCalled();
    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });

  it('keeps the local pending receipt unchanged when resolve delivery reports unknown', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = approvalItem(sessionIdentity, recordKey);
    hostSessionResolveApprovalMock.mockResolvedValueOnce({ outcome: 'unknown' });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval(approval, 'allow-once');

    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });

  it('keeps the local pending receipt when resolve delivery reports target rejection', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = approvalItem(sessionIdentity, recordKey);
    hostSessionResolveApprovalMock.mockResolvedValueOnce({ outcome: 'target_rejected' });
    hostSessionApprovalsMock.mockResolvedValueOnce({ approvals: [approval] });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval(approval, 'allow-once');

    expect(hostSessionResolveApprovalMock).toHaveBeenCalledWith({
      id: 'approval-1',
      sessionKey: 'agent:test:main',
      endpointSessionId: 'native-session-1',
      sessionIdentity,
      decision: 'allow-once',
    });
    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
    expect(useChatStore.getState().error).toBe('approval target rejected');
  });
});
