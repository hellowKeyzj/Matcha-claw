import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostApiFetchMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

describe('team runtime client', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
  });

  it('teamInit 走 Host API', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ runtimeRoot: '/runtime', run: { teamId: 'team-1' } });
    const { teamInit } = await import('@/features/teams/api/runtime-client');

    await teamInit({ teamId: 'team-1', leadAgentId: 'main' });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/team-runtime/init', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'team-1', leadAgentId: 'main' }),
    });
  });

  it('teamMailboxPull 走 Host API', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ messages: [], nextCursor: 'cursor-1' });
    const { teamMailboxPull } = await import('@/features/teams/api/runtime-client');

    await teamMailboxPull({ teamId: 'team-1', cursor: 'cursor-0', limit: 50 });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/team-runtime/mailbox-pull', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'team-1', cursor: 'cursor-0', limit: 50 }),
    });
  });
});
