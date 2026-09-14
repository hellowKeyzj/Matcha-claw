import { describe, expect, it, vi } from 'vitest';
import { createTeamHumanDecisionTransport } from '../../electron/main/runtime-host-delivery/transport/teams/decision';

function issuer() {
  return {
    verificationKey: 'public-key',
    signDecision: vi.fn().mockReturnValue('signed-team-decision'),
  };
}

function response(status: number, body: unknown): Response {
  return {
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('Electron Main Team human decision transport', () => {
  const request = {
    runId: 'run-1',
    approvalId: 'approval-1',
    decision: 'approve' as const,
    note: 'Approved',
    idempotencyKey: 'decision-1',
  };

  it('sends the signed fixed Team decision request to the Rust loopback transport', async () => {
    const deliveryIssuer = issuer();
    const fetcher = vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'recorded' }));
    const transport = createTeamHumanDecisionTransport(deliveryIssuer, 32_134, fetcher as never);

    await expect(transport.resolve(request)).resolves.toEqual({
      status: 200,
      body: { success: true, outcome: 'recorded' },
    });
    expect(deliveryIssuer.signDecision).toHaveBeenCalledWith({
      principal: 'electron-main-local',
      endpoint: '/api/team/decision',
      scope: 'team:write',
      capability: 'team.decision.resolve',
      subject: 'team-decision',
      expiresAt: expect.any(Number),
      revision: '1',
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32134/api/team/decision', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-team-decision',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  });

  it('preserves durable replay without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'replayed' }));
    const transport = createTeamHumanDecisionTransport(issuer(), 32_134, fetcher as never);

    await expect(transport.resolve(request)).resolves.toEqual({
      status: 200,
      body: { success: true, outcome: 'replayed' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown as a non-success outcome without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(409, {
      success: false,
      outcome: 'outcome-unknown',
      error: 'Team human decision outcome is unknown',
    }));
    const transport = createTeamHumanDecisionTransport(issuer(), 32_134, fetcher as never);

    await expect(transport.resolve(request)).resolves.toEqual({
      status: 409,
      body: {
        success: false,
        outcome: 'outcome-unknown',
        error: 'Team human decision outcome is unknown',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('projects explicit Rust rejection without exposing private details', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(409, { success: false, error: 'Team human decision was rejected' })
    );
    const transport = createTeamHumanDecisionTransport(issuer(), 32_134, fetcher as never);

    await expect(transport.resolve(request)).resolves.toEqual({
      status: 409,
      body: { success: false, error: 'Team human decision was rejected' },
    });
  });

  it('rejects extra caller-controlled fields without calling Rust', async () => {
    const fetcher = vi.fn();
    const transport = createTeamHumanDecisionTransport(issuer(), 32_134, fetcher as never);

    await expect(transport.resolve({ ...request, stageId: 'stage-1' } as never)).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Team human decision request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts malformed and failed native delivery outcomes', async () => {
    const cases = [
      vi.fn().mockResolvedValue(response(200, { success: true, outcome: 'private-delivery-id' })),
      vi.fn().mockResolvedValue(
        response(409, { success: false, error: 'private rejection detail' })
      ),
      vi.fn().mockRejectedValue(new Error('private note/token/path detail')),
    ];

    for (const fetcher of cases) {
      const transport = createTeamHumanDecisionTransport(issuer(), 32_134, fetcher as never);
      const result = await transport.resolve(request);
      expect(result).toEqual({
        status: 503,
        body: { success: false, error: 'Team human decision is unavailable' },
      });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain(request.note);
    }
  });
});
