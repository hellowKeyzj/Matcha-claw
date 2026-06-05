import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostCapabilityExecuteMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const runtimeAddress: RuntimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'team.coordination',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

describe('team runtime client', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
  });

  it('teamInit resolves team.coordination address once and persists it in the payload', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({ runtimeRoot: '/runtime', run: { teamId: 'team-1', runtimeAddress } });
    const { teamInit } = await import('@/features/teams/api/runtime-client');

    await teamInit({ teamId: 'team-1', leadAgentId: 'main' });

    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.coordination',
        operationId: 'team.init',
        runtimeAddress,
        input: expect.objectContaining({ teamId: 'team-1', leadAgentId: 'main', runtimeAddress }),
      }),
      undefined,
    );
  });

  it('teamMailboxPull uses the runtimeAddress supplied by run meta', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({ messages: [], nextCursor: 'cursor-1' });
    const { teamMailboxPull } = await import('@/features/teams/api/runtime-client');

    await teamMailboxPull({ teamId: 'team-1', runtimeAddress, cursor: 'cursor-0', limit: 50 });

    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.coordination',
        operationId: 'team.mailboxPull',
        runtimeAddress,
        input: expect.objectContaining({ teamId: 'team-1', runtimeAddress, cursor: 'cursor-0', limit: 50 }),
      }),
      undefined,
    );
  });
});
