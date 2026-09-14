import { describe, expect, it, vi } from 'vitest';
import { createTeamRoleChatTransport } from '../../electron/main/runtime-host-delivery/transport/teams/role-chat';

const request = {
  teamId: 'team-1',
  runId: 'run-1',
  roleId: 'leader',
  message: 'private message canary',
  idempotencyKey: 'role-chat-1',
};

function issuer() {
  return {
    verificationKey: 'public-key',
    signDecision: vi.fn().mockReturnValue('signed-team-role-chat'),
  };
}

function response(status: number, body: unknown): Response {
  return {
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('Electron Main Team role-chat transport', () => {
  it('sends the signed fixed role-chat DTO to the Rust loopback transport', async () => {
    const deliveryIssuer = issuer();
    const fetcher = vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'accepted' }));
    const transport = createTeamRoleChatTransport(deliveryIssuer, 32_138, fetcher as never);

    await expect(transport.submit(request)).resolves.toEqual({
      status: 200,
      body: { success: true, outcome: 'accepted' },
    });
    expect(deliveryIssuer.signDecision).toHaveBeenCalledWith({
      principal: 'electron-main-local',
      endpoint: '/api/team/role-chat',
      scope: 'team:write',
      capability: 'team.role-chat.submit',
      subject: 'team-role-chat',
      expiresAt: expect.any(Number),
      revision: '1',
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32138/api/team/role-chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-team-role-chat',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  });

  it('preserves rejected without private receipts or retries', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'rejected' }));
    const transport = createTeamRoleChatTransport(issuer(), 32_138, fetcher as never);

    await expect(transport.submit(request)).resolves.toEqual({
      status: 200,
      body: { success: true, outcome: 'rejected' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown as a non-success outcome without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(409, {
      success: false,
      outcome: 'outcome-unknown',
      error: 'Team role chat outcome is unknown',
    }));
    const transport = createTeamRoleChatTransport(issuer(), 32_138, fetcher as never);

    await expect(transport.submit(request)).resolves.toEqual({
      status: 409,
      body: {
        success: false,
        outcome: 'outcome-unknown',
        error: 'Team role chat outcome is unknown',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown fields and oversized messages before Rust delivery', async () => {
    const fetcher = vi.fn();
    const transport = createTeamRoleChatTransport(issuer(), 32_138, fetcher as never);

    await expect(transport.submit({ ...request, deliveryId: 'private-id' } as never)).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Team role chat request is invalid' },
    });
    await expect(transport.submit({ ...request, message: 'x'.repeat(16 * 1024 + 1) })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Team role chat request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts native delivery failures and malformed outcomes', async () => {
    const cases = [
      vi.fn().mockRejectedValue(new Error('private message token path')),
      vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'delivery-id' })),
      vi.fn().mockResolvedValue(response(503, { success: false, error: request.message })),
    ];

    for (const fetcher of cases) {
      const transport = createTeamRoleChatTransport(issuer(), 32_138, fetcher as never);
      const result = await transport.submit(request);
      expect(result).toEqual({
        status: 503,
        body: { success: false, error: 'Team role chat is unavailable' },
      });
      expect(JSON.stringify(result)).not.toContain('private message canary');
      expect(JSON.stringify(result)).not.toContain('token');
      expect(JSON.stringify(result)).not.toContain('path');
    }
  });
});
