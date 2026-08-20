import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
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
const hostSessionRespondApprovalMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionApprovals: (...args: unknown[]) => hostSessionApprovalsMock(...args),
  hostSessionRespondApproval: (...args: unknown[]) => hostSessionRespondApprovalMock(...args),
  hostSessionAbort: vi.fn(),
  hostSessionSend: vi.fn(),
  hostSessionList: vi.fn(),
  hostSessionNew: vi.fn(),
  hostSessionDelete: vi.fn(),
  hostSessionWindowFetch: vi.fn(),
  waitForRuntimeJobResult: vi.fn(),
}));

function buildSessionRecord(sessionIdentity: SessionIdentity | null, backendSessionKey: string, endpointSessionId?: string) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      backendSessionKey,
      endpointSessionId: endpointSessionId ?? null,
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

  it('projects only opaque Matcha approval identifiers from the native snapshot', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    hostSessionApprovalsMock.mockResolvedValueOnce({
      approvals: [{ approvalId: 'approval-1', optionIds: ['option-1'] }],
    });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'agent:test:main', 'native-session-1'),
      },
      pendingApprovalsBySession: {},
    } as never);

    await useChatStore.getState().syncPendingApprovals(recordKey);

    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({
      endpoint: sessionIdentity.endpoint,
      sessionId: 'native-session-1',
    });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({
      [recordKey]: [{
        approvalId: 'approval-1',
        optionIds: ['option-1'],
        sessionKey: recordKey,
      }],
    });
  });

  it('refreshes the native snapshot after a response receipt without local removal', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('main', 'main');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = {
      approvalId: 'approval-1',
      optionIds: ['option-1'],
      sessionKey: recordKey,
    };
    hostSessionRespondApprovalMock.mockResolvedValueOnce({ outcome: 'responded' });
    hostSessionApprovalsMock.mockResolvedValueOnce({ approvals: [approval] });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'main', 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval(approval, 'option-1');

    expect(hostSessionRespondApprovalMock).toHaveBeenCalledWith({
      endpoint: sessionIdentity.endpoint,
      sessionId: 'native-session-1',
      approvalId: 'approval-1',
      optionId: 'option-1',
    });
    expect(hostSessionApprovalsMock).toHaveBeenCalledWith({
      endpoint: sessionIdentity.endpoint,
      sessionId: 'native-session-1',
    });
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });

  it('rejects unknown and cross-session approvals without delivery or local changes', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const otherRecordKey = buildSessionRecordKey(createMatchaAgentTestSessionIdentity('agent:other:main', 'test'));
    const approval = {
      approvalId: 'approval-1',
      optionIds: ['option-1'],
      sessionKey: recordKey,
    };
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'agent:test:main', 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval({ ...approval, sessionKey: otherRecordKey }, 'option-1');
    await useChatStore.getState().resolveApproval(approval, 'unknown-option');

    expect(hostSessionRespondApprovalMock).not.toHaveBeenCalled();
    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });

  it('keeps the native snapshot unchanged after unknown response outcome', async () => {
    const sessionIdentity = createMatchaAgentTestSessionIdentity('agent:test:main', 'test');
    const recordKey = buildSessionRecordKey(sessionIdentity);
    const approval = {
      approvalId: 'approval-1',
      optionIds: ['option-1'],
      sessionKey: recordKey,
    };
    hostSessionRespondApprovalMock.mockResolvedValueOnce({ outcome: 'unknown' });
    useChatStore.setState({
      currentSessionKey: recordKey,
      loadedSessions: {
        [recordKey]: buildSessionRecord(sessionIdentity, 'agent:test:main', 'native-session-1'),
      },
      pendingApprovalsBySession: { [recordKey]: [approval] },
    } as never);

    await useChatStore.getState().resolveApproval(approval, 'option-1');

    expect(hostSessionApprovalsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingApprovalsBySession).toEqual({ [recordKey]: [approval] });
  });
});
