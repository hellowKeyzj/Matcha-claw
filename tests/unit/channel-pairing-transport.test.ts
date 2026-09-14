import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChannelPairingTransport } from '../../electron/main/runtime-host-delivery/transport/channels/pairing';

describe('Electron Main channel pairing transport', () => {
  beforeEach(() => vi.clearAllMocks());
  it('signs and sends only a channel list request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        requests: [{ id: 'request-1', status: 'pending' }],
      }),
    });
    const transport = createChannelPairingTransport({ verificationKey: 'public', signDecision }, 32_137, fetcher);

    await expect(transport.list('feishu', 'default')).resolves.toEqual({
      status: 200,
      body: {
        requests: [{ id: 'request-1', status: 'pending' }],
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/pairing',
      scope: 'channels:read',
      capability: 'channels.pairing.list',
      subject: 'channel-pairing',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32137/api/channels/pairing', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify({ channel: 'feishu', accountId: 'default' }),
    }));
  });

  it('sends an explicit code through signed Host approval', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-approval-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'confirmed' }) });
    const transport = createChannelPairingTransport({ verificationKey: 'public', signDecision }, 32_137, fetcher);
    await expect(transport.approve({ channel: 'feishu', accountId: 'default', code: 'SYNTHETICPAIRINGCODE' })).resolves.toEqual({ status: 200, body: { outcome: 'confirmed' } });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32137/api/channels/pairing', expect.objectContaining({ body: JSON.stringify({ action: 'approve', channel: 'feishu', accountId: 'default', code: 'SYNTHETICPAIRINGCODE' }) }));
  });

  it('returns unavailable for malformed approval data and transport failures', async () => {
    const malformed = createChannelPairingTransport({ verificationKey: 'public', signDecision: () => 'signed-decision' }, 32_137, vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'approved' }) }));
    const failed = createChannelPairingTransport({ verificationKey: 'public', signDecision: () => 'signed-decision' }, 32_137, vi.fn().mockRejectedValue(new Error('private pairing failure')));
    await expect(malformed.approve({ channel: 'feishu', code: 'SYNTHETICPAIRINGCODE' })).resolves.toEqual({ status: 503, body: { success: false, error: 'Channel pairing is unavailable' } });
    await expect(failed.approve({ channel: 'feishu', code: 'SYNTHETICPAIRINGCODE' })).resolves.toEqual({ status: 503, body: { success: false, error: 'Channel pairing is unavailable' } });
  });

  it('redacts malformed native data and failures', async () => {
    const malformed = createChannelPairingTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_137,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          requests: [{
            id: 'request-1',
            status: 'pending',
            unexpected: true,
          }],
        }),
      }),
    );
    const failed = createChannelPairingTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_137,
      vi.fn().mockRejectedValue(new Error('private pairing output')),
    );

    await expect(malformed.list('feishu')).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Channel pairing is unavailable' },
    });
    const response = await failed.list('feishu');
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Channel pairing is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private pairing output');
  });
});
