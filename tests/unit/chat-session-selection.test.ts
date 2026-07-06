import { describe, expect, it } from 'vitest';
import { pickStartupSessionFallback } from '@/stores/chat/session-selection';
import type { ChatSession } from '@/stores/chat/types';

function session(key: string, updatedAt: number, overrides: Partial<ChatSession> = {}): ChatSession {
  const agentId = overrides.agentId ?? key.split(':')[1] ?? 'main';
  return {
    key,
    backendSessionKey: key,
    agentId,
    protocolId: 'openclaw-v4',
    runtimeEndpointId: 'local',
    sessionIdentity: {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId,
      sessionKey: key,
    },
    updatedAt,
    ...overrides,
  };
}

describe('pickStartupSessionFallback', () => {
  it('prefers the agent main session when present', () => {
    const sessions = [
      session('agent:main:cron:heartbeat', 9_000),
      session('agent:main:active', 8_000),
      session('agent:main:main', 1_000),
    ];

    expect(pickStartupSessionFallback('agent:main:active', sessions)).toBe('agent:main:main');
  });

  it('prefers the latest non-cron session for the same agent', () => {
    const sessions = [
      session('agent:main:cron:heartbeat', 9_000),
      session('agent:main:active', 1_000),
      session('agent:main:session-old', 2_000),
      session('agent:main:session-new', 5_000),
    ];

    expect(pickStartupSessionFallback('agent:main:active', sessions)).toBe('agent:main:session-new');
  });

  it('uses session metadata agent ownership instead of session key grammar', () => {
    const current = session('custom-current', 3_000, { agentId: 'researcher' });
    const sameAgentMain = session('custom-main', 1_000, {
      agentId: 'researcher',
      backendSessionKey: 'agent:researcher:main',
    });
    const otherAgentNewer = session('agent:main:session-new', 9_000, { agentId: 'main' });

    expect(pickStartupSessionFallback('custom-current', [current, sameAgentMain, otherAgentNewer])).toBe('custom-main');
  });

  it('falls back globally when the current session is missing instead of defaulting to main agent ownership', () => {
    const sessions = [
      session('agent:main:main', 1_000),
      session('agent:writer:session-new', 9_000),
      session('agent:writer:cron:heartbeat', 10_000),
    ];

    expect(pickStartupSessionFallback('agent:main:missing', sessions)).toBe('agent:writer:session-new');
  });

  it('does not select cron sessions when only cron sessions exist', () => {
    expect(pickStartupSessionFallback('agent:main:missing', [
      session('agent:main:cron:heartbeat', 9_000),
    ])).toBeNull();
  });
});
