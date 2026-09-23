import { describe, expect, it, vi } from 'vitest';
import { buildSessionIdentityKey } from '../../electron/desktop-contract/runtime-address';

const sessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'alpha',
  sessionKey: 'agent:alpha:direct-session',
};

vi.mock('@/lib/host-api', () => ({
  hostSessionList: vi.fn(async () => ({
    sessions: [{
      key: 'agent:alpha:direct-session',
      agentId: 'alpha',
      sessionIdentity,
      kind: 'session',
      endpointSessionId: 'direct-session',
      updatedAt: 42,
      modelState: {
        selected: { provider: 'provider', model: 'private-default-model', ref: 'provider/private-default-model' },
      },
    }],
  })),
}));

describe('runtime session list', () => {
  it('projects only the verified native catalog identity into a chat session', async () => {
    const { listSessions } = await import('@/services/runtime/session-runtime');

    await expect(listSessions({ endpoint: sessionIdentity.endpoint })).resolves.toEqual([{
      key: buildSessionIdentityKey(sessionIdentity),
      agentId: 'alpha',
      sessionIdentity,
      kind: 'session',
      endpointSessionId: 'direct-session',
      preferred: false,
      modelState: {
        selected: { provider: 'provider', model: 'private-default-model', ref: 'provider/private-default-model' },
      },
      updatedAt: 42,
    }]);
  });

  it('does not synthesize catalog metadata while preserving the native model state', async () => {
    const { listSessions } = await import('@/services/runtime/session-runtime');

    const [session] = await listSessions({ endpoint: sessionIdentity.endpoint });

    expect(session).not.toHaveProperty('label');
    expect(session).not.toHaveProperty('displayName');
    expect(session.modelState?.selected?.ref).toBe('provider/private-default-model');
  });
});
