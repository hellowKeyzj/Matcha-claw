import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

describe('channel runtime client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports probe as unavailable without submitting a generic job', async () => {
    const { hostChannelsProbe } = await import('@/lib/channel-runtime');

    await expect(hostChannelsProbe()).rejects.toThrow('Channel probe is unavailable');
    expect(hostApiFetchMock).not.toHaveBeenCalled();
  });

  it('applies non-QR configuration through the named configure endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'confirmed' });
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await expect(hostChannelsActivate({
      channelType: 'wecom',
      accountId: 'main',
      config: { botId: 'bot-1' },
    })).resolves.toEqual({ success: true });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/configure', {
      method: 'POST',
      body: JSON.stringify({
        action: 'apply',
        channel: 'wecom',
        accountId: 'main',
        values: { botId: 'bot-1' },
      }),
    });
  });

  it.each([
    ['target_rejected', 'Channel configuration was rejected'],
    ['unknown', 'Channel configuration outcome is unknown'],
  ] as const)('surfaces a non-confirmed configure outcome: %s', async (outcome, error) => {
    hostApiFetchMock.mockResolvedValue({ outcome });
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await expect(hostChannelsActivate({
      channelType: 'feishu',
      config: {},
    })).resolves.toEqual({ success: false, error });
  });

  it('starts QR activation and returns the response-driven progress', async () => {
    const progress = {
      outcome: 'progress' as const,
      channel: 'whatsapp',
      accountId: 'main',
      qrDataUrl: 'data:image/png;base64,qr',
      sessionKey: 'login-session-1',
    };
    hostApiFetchMock.mockResolvedValue(progress);
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await expect(hostChannelsActivate({
      channelType: 'whatsapp',
      accountId: 'main',
      config: { phoneNumber: '+1' },
    })).resolves.toEqual({ success: true, progress });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/login', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: 'whatsapp',
        accountId: 'main',
        force: true,
        config: { phoneNumber: '+1' },
      }),
    });
  });

  it('returns a connected QR activation response without starting a wait', async () => {
    const progress = {
      outcome: 'connected' as const,
      channel: 'openclaw-weixin',
      accountId: 'default',
      sessionKey: 'login-session-connected',
    };
    hostApiFetchMock.mockResolvedValue(progress);
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await expect(hostChannelsActivate({
      channelType: 'openclaw-weixin',
      config: {},
    })).resolves.toEqual({ success: true, progress });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits through the named login endpoint with QR refresh, session state, timeout, and abort signal', async () => {
    const controller = new AbortController();
    const progress = {
      outcome: 'progress' as const,
      channel: 'whatsapp',
      accountId: 'main',
      qrDataUrl: 'data:image/png;base64,qr-refresh',
      sessionKey: 'login-session-2',
    };
    hostApiFetchMock.mockResolvedValue(progress);
    const { hostChannelsLoginWait } = await import('@/lib/channel-runtime');

    await expect(hostChannelsLoginWait('whatsapp', 'main', {
      sessionKey: 'login-session-1',
      currentQrDataUrl: 'data:image/png;base64,qr-old',
      timeoutMs: 300_000,
      signal: controller.signal,
    })).resolves.toEqual(progress);

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/login', {
      method: 'POST',
      timeoutMs: 300_000,
      signal: controller.signal,
      body: JSON.stringify({
        action: 'wait',
        channel: 'whatsapp',
        accountId: 'main',
        sessionKey: 'login-session-1',
        currentQrDataUrl: 'data:image/png;base64,qr-old',
        timeoutMs: 300_000,
      }),
    });
  });

  it('cancels a QR session through the named session owner', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'cancelled' });
    const { hostChannelsCancelSession } = await import('@/lib/channel-runtime');

    await expect(hostChannelsCancelSession('whatsapp', 'main')).resolves.toEqual({ outcome: 'cancelled' });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/login', {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel', channel: 'whatsapp', accountId: 'main' }),
    });
  });

  it('deletes configuration through the named endpoint and preserves the account', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'confirmed' });
    const { hostChannelsDeleteConfig } = await import('@/lib/channel-runtime');

    await expect(hostChannelsDeleteConfig('wecom', 'backup')).resolves.toEqual({
      outcome: 'confirmed',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/delete-config', {
      method: 'POST',
      body: JSON.stringify({ channel: 'wecom', accountId: 'backup' }),
    });
  });

  it('keeps pairing requests as a safe projection and approves only confirmed responses', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ requests: [{ id: 'request-1', status: 'pending' }] })
      .mockResolvedValueOnce({ outcome: 'confirmed' });
    const { hostChannelsApprovePairingRequest, hostChannelsListPairingRequests } = await import('@/lib/channel-runtime');

    await expect(hostChannelsListPairingRequests('feishu', 'default')).resolves.toEqual({
      success: true,
      requests: [{ id: 'request-1', status: 'pending' }],
    });
    await expect(hostChannelsApprovePairingRequest('feishu', {
      code: 'SYNTHETICPAIRINGCODE',
      accountId: 'default',
    })).resolves.toEqual({ success: true });

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/channels/pairing', {
      method: 'POST',
      body: JSON.stringify({ channel: 'feishu' }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/channels/pairing', {
      method: 'POST',
      body: JSON.stringify({
        action: 'approve',
        channel: 'feishu',
        accountId: 'default',
        code: 'SYNTHETICPAIRINGCODE',
      }),
    });
  });
});
