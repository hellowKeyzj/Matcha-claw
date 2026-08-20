import { describe, expect, it, vi } from 'vitest';

const hostApiFetch = vi.fn();

vi.mock('@/lib/host-api', () => ({ hostApiFetch }));

describe('Team role-chat renderer client', () => {
  it('posts the exact public DTO without a private delivery receipt', async () => {
    hostApiFetch.mockResolvedValueOnce({ success: true, outcome: 'accepted' });
    const { submitTeamRoleChat } = await import('@/services/team-role-chat');

    await expect(submitTeamRoleChat({
      teamId: 'team-1',
      runId: 'run-1',
      roleId: 'leader',
      message: 'hello',
      idempotencyKey: 'role-chat-1',
    })).resolves.toEqual({ success: true, outcome: 'accepted' });

    expect(hostApiFetch).toHaveBeenCalledWith('/api/team/role-chat', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'team-1',
        runId: 'run-1',
        roleId: 'leader',
        message: 'hello',
        idempotencyKey: 'role-chat-1',
      }),
      timeoutMs: 60_000,
    });
  });
});
