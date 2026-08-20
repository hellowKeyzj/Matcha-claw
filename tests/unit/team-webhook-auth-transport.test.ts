import { describe, expect, it, vi } from 'vitest';
import { createTeamWebhookAuthTransport } from '../../electron/main/runtime-host-delivery/transport/teams/webhook-auth';

const projection = {
  success: true,
  enabled: true,
  source: 'settings',
  headerName: 'x-matchaclaw-webhook-token',
  authorizationScheme: 'Bearer',
  maskedToken: 'mctwh_…beef',
  copySupported: false,
} as const;

const issuer = {
  verificationKey: 'public',
  signDecision: vi.fn().mockReturnValue('signed-decision'),
};

describe('Electron Main Team webhook auth transport', () => {
  it('signs the read capability and sends only the dedicated empty request', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => projection,
    });
    const transport = createTeamWebhookAuthTransport(issuer, 34_127, fetcher);

    await expect(transport.read()).resolves.toEqual({ status: 200, body: projection });
    expect(issuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/team/webhook-auth',
      scope: 'team:read',
      capability: 'team.webhook-auth',
      subject: 'team-webhook-auth',
      revision: '1',
      expiresAt: expect.any(Number),
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34127/api/team/webhook-auth',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer signed-decision',
          'Content-Type': 'application/json',
        }),
        body: '{}',
      }),
    );
  });

  it.each([
    { ...projection, diagnostics: 'private native detail' },
    { ...projection, maskedToken: `mctwh_${'a'.repeat(64)}` },
    { ...projection, source: 'canonical-state' },
    { ...projection, copySupported: true },
  ])('rejects an invalid native projection without exposing its contents', async (body) => {
    const transport = createTeamWebhookAuthTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_127,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    const response = await transport.read();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Team webhook auth is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private native detail');
    expect(JSON.stringify(response)).not.toContain(`mctwh_${'a'.repeat(64)}`);
  });

  it('fails closed on loopback transport errors', async () => {
    const transport = createTeamWebhookAuthTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_127,
      vi.fn().mockRejectedValue(new Error('private loopback failure')),
    );

    await expect(transport.read()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Team webhook auth is unavailable' },
    });
  });
});
