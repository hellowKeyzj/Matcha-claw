import { describe, expect, it, vi } from 'vitest';
import { createSecurityEmergencyTransport } from '../../electron/main/runtime-host-delivery/transport/security/emergency';

describe('Electron Main security emergency transport', () => {
  it('signs and sends only the fixed empty request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'applied' }),
    });
    const transport = createSecurityEmergencyTransport({ verificationKey: 'public', signDecision }, 34_107, fetcher);

    await expect(transport.run()).resolves.toEqual({
      status: 200,
      body: { outcome: 'applied' },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/security/emergency',
      scope: 'security:write',
      capability: 'security.emergency',
      subject: 'security-emergency',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34107/api/security/emergency', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: '{}',
    }));
  });

  it.each(['target_rejected', 'outcome_unknown'] as const)('projects the sealed %s outcome', async (outcome) => {
    const transport = createSecurityEmergencyTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_107,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome }) }),
    );

    await expect(transport.run()).resolves.toEqual({ status: 200, body: { outcome } });
  });

  it('redacts malformed native responses and transport failures', async () => {
    const malformed = createSecurityEmergencyTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_107,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ outcome: 'applied', evidenceDir: 'C:/private/native/evidence' }),
      }),
    );
    const failed = createSecurityEmergencyTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_107,
      vi.fn().mockRejectedValue(new Error('native policy details')),
    );

    await expect(malformed.run()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security emergency is unavailable' },
    });
    const response = await failed.run();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Security emergency is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('native policy details');
  });
});
