import { describe, expect, it } from 'vitest';
import { pickStartupSessionFallback } from '@/stores/chat/session-selection';
import type { ChatSession } from '@/stores/chat/types';

function session(key: string, updatedAt: number): ChatSession {
  const agentId = key.split(':')[1] ?? 'main';
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
  };
}

describe('pickStartupSessionFallback', () => {
  it('prefers the agent main session when present', () => {
    const sessions = [
      session('agent:main:cron:heartbeat', 9_000),
      session('agent:main:main', 1_000),
    ];

    expect(pickStartupSessionFallback('agent:main:missing', sessions)).toBe('agent:main:main');
  });

  it('prefers the latest non-cron session for the same agent', () => {
    const sessions = [
      session('agent:main:cron:heartbeat', 9_000),
      session('agent:main:session-old', 2_000),
      session('agent:main:session-new', 5_000),
    ];

    expect(pickStartupSessionFallback('agent:main:missing', sessions)).toBe('agent:main:session-new');
  });

  it('does not select cron sessions when only cron sessions exist', () => {
    expect(pickStartupSessionFallback('agent:main:missing', [
      session('agent:main:cron:heartbeat', 9_000),
    ])).toBeNull();
  });
});
