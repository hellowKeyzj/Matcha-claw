import { describe, expect, it, vi } from 'vitest';
import { createChannelDeleteConfigTransport } from '../../electron/main/runtime-host-delivery/transport/channels/delete-config';

describe('Electron Main channel delete-config transport', () => {
  it.each(['confirmed', 'target_rejected', 'unknown'] as const)('projects the sealed %s outcome', async (outcome) => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome }) });
    const transport = createChannelDeleteConfigTransport(
      { verificationKey: 'public', signDecision },
      32_138,
      fetcher,
    );

    await expect(transport.deleteConfig({ channel: 'feishu', accountId: 'default' })).resolves.toEqual({
      status: 200,
      body: { outcome },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/delete-config',
      scope: 'channels:write',
      capability: 'channels.config.delete',
      subject: 'channel-config-delete',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:32138/api/channels/delete-config',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify({ channel: 'feishu', accountId: 'default' }),
      }),
    );
  });

  it('accepts only the exact rejected envelope and fails closed on malformed responses', async () => {
    const rejected = createChannelDeleteConfigTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_138,
      vi.fn().mockResolvedValue({ status: 400, json: async () => ({ outcome: 'rejected' }) }),
    );
    await expect(rejected.deleteConfig({ channel: 'feishu', accountId: 'default' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });

    const malformed = createChannelDeleteConfigTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_138,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'confirmed', secret: 'private' }) }),
    );
    await expect(malformed.deleteConfig({ channel: 'feishu', accountId: 'default' })).resolves.toEqual({
      status: 503,
      body: { outcome: 'unknown' },
    });
  });

  it('rejects invalid DTOs before signing or sending', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn();
    const transport = createChannelDeleteConfigTransport(
      { verificationKey: 'public', signDecision },
      32_138,
      fetcher,
    );

    await expect(transport.deleteConfig({ channel: 'bad channel', accountId: 'default' })).resolves.toEqual({
      status: 503,
      body: { outcome: 'unknown' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
