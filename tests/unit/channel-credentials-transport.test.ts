import { describe, expect, it, vi } from 'vitest';
import { createChannelCredentialsTransport } from '../../electron/main/runtime-host-delivery/transport/channels/credentials';

const SYNTHETIC_TOKEN = 'synthetic-token-sentinel';
const INPUT = {
  channelType: 'discord',
  config: { token: SYNTHETIC_TOKEN },
} as const;

describe('Electron Main channel credentials transport', () => {
  it('signs and forwards the frozen candidate DTO', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        valid: true,
        errors: [],
        warnings: [],
        details: { botUsername: 'matcha-bot' },
      }),
    });
    const transport = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision },
      32_139,
      fetcher,
    );

    await expect(transport.validate(INPUT)).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        valid: true,
        errors: [],
        warnings: [],
        details: { botUsername: 'matcha-bot' },
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/credentials/validate',
      scope: 'channels:write',
      capability: 'channels.credentials.validate',
      subject: 'channel-credentials',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:32139/api/channels/credentials/validate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(INPUT),
      }),
    );
  });

  it('preserves an explicit credential rejection without exposing the candidate', async () => {
    const transport = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_139,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          valid: false,
          errors: ['The provider rejected the candidate credential'],
          warnings: [],
        }),
      }),
    );

    await expect(transport.validate(INPUT)).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        valid: false,
        errors: ['The provider rejected the candidate credential'],
        warnings: [],
      },
    });
  });

  it('fails closed for malformed, secret-leaking, and failed native responses', async () => {
    const malformed = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_139,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, valid: true, details: { token: SYNTHETIC_TOKEN } }),
      }),
    );
    const leaking = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_139,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, valid: false, errors: [`Rejected ${SYNTHETIC_TOKEN}`] }),
      }),
    );
    const failed = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_139,
      vi.fn().mockRejectedValue(new Error('private native detail')),
    );

    for (const transport of [malformed, leaking, failed]) {
      const response = await transport.validate(INPUT);
      expect(response).toEqual({
        status: 503,
        body: { success: false, error: 'Channel credentials validation is unavailable' },
      });
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_TOKEN);
      expect(JSON.stringify(response)).not.toContain('private native detail');
    }
  });

  it('rejects malformed candidate DTOs before signing or sending', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn();
    const transport = createChannelCredentialsTransport(
      { verificationKey: 'public', signDecision },
      32_139,
      fetcher,
    );

    await expect(transport.validate({
      channelType: 'discord',
      config: { token: SYNTHETIC_TOKEN, extra: 1 as never },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Channel credentials validation is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
