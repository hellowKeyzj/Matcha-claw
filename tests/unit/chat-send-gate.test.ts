import { describe, expect, it } from 'vitest';
import {
  areCurrentChatSendGateSourcesEquivalent,
  deriveChatSendGate,
  type CurrentChatSendGateSource,
} from '@/stores/chat/send-gate';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const sessionKey = 'agent:main:automation';
const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey, 'main');

function sessionSource(overrides: Partial<Extract<CurrentChatSendGateSource, { kind: 'session' }>> = {}): Extract<CurrentChatSendGateSource, { kind: 'session' }> {
  return {
    kind: 'session',
    sessionKey,
    endpointSessionId: null,
    sessionIdentity,
    historyStatus: 'ready',
    sessionKind: 'session',
    runPhase: 'idle',
    activeRunId: null,
    pendingTurnKey: null,
    activeTurnItemKey: null,
    ...overrides,
  };
}

describe('chat send gate', () => {
  it('blocks automation session prompts', () => {
    expect(deriveChatSendGate(sessionSource({ sessionKind: 'automation' }))).toEqual({
      canSend: false,
      reason: 'automation-session',
      sessionKey,
    });
  });

  it('uses session kind in source equivalence', () => {
    expect(areCurrentChatSendGateSourcesEquivalent(
      sessionSource({ sessionKind: 'session' }),
      sessionSource({ sessionKind: 'automation' }),
    )).toBe(false);
  });
});
