import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const getCallMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, init: unknown) => decode(await hostApiFetchMock(path, init)),
}));
vi.mock('@/lib/call-log', () => ({ getCall: getCallMock }));
vi.mock('@/lib/host-events', () => ({ subscribeHostEvent: () => () => {}, subscribeBrowserRecovery: () => () => {} }));

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
      agentId: 'support',
      config: { botId: 'bot-1' },
    }, { traceId: 'd87d94ee-0ac8-4a60-a8b3-8f53637c6362' })).resolves.toEqual({ success: true });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/configure', {
      traceId: 'd87d94ee-0ac8-4a60-a8b3-8f53637c6362',
      timeoutMs: 240_000,
      method: 'POST',
      body: JSON.stringify({
        action: 'apply',
        channel: 'wecom',
        accountId: 'main',
        agentId: 'support',
        values: { botId: 'bot-1' },
      }),
    });
  });

  it('applies direct QR configuration through the configure endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'confirmed' });
    const { hostChannelsConfigure } = await import('@/lib/channel-runtime');

    await expect(hostChannelsConfigure({
      channelType: 'openclaw-weixin',
      accountId: 'wx-main',
      agentId: 'support',
      config: {},
    }, { traceId: 'd87d94ee-0ac8-4a60-a8b3-8f53637c6362' })).resolves.toEqual({ success: true });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/configure', {
      traceId: 'd87d94ee-0ac8-4a60-a8b3-8f53637c6362',
      timeoutMs: 240_000,
      method: 'POST',
      body: JSON.stringify({
        action: 'apply',
        channel: 'openclaw-weixin',
        accountId: 'wx-main',
        agentId: 'support',
        values: {},
      }),
    });
  });

  it('omits a blank agent id from activation bodies', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'confirmed' });
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await hostChannelsActivate({
      channelType: 'feishu',
      agentId: '  ',
      config: {},
    });

    const requestOptions = hostApiFetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(requestOptions.body)).not.toHaveProperty('agentId');
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
      agentId: 'support',
      config: { phoneNumber: '+1' },
    })).resolves.toEqual({ success: true, progress });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/login', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: 'whatsapp',
        accountId: 'main',
        agentId: 'support',
        force: true,
        config: { phoneNumber: '+1' },
      }),
    });
  });

  it('returns a connected QR activation response without starting a wait', async () => {
    const progress = {
      outcome: 'connected' as const,
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      sessionKey: 'login-session-connected',
    };
    hostApiFetchMock.mockResolvedValue(progress);
    const { hostChannelsActivate } = await import('@/lib/channel-runtime');

    await expect(hostChannelsActivate({
      channelType: 'openclaw-weixin',
      accountId: 'wechat-main',
      config: {},
    })).resolves.toEqual({ success: true, progress });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/login', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        force: true,
        config: {},
      }),
    });
    const requestOptions = hostApiFetchMock.mock.calls[0]?.[1] as { body: string };
    const requestBody = JSON.parse(requestOptions.body);
    for (const key of ['directLogin', 'alreadyConnected', 'token', 'message']) {
      expect(requestBody).not.toHaveProperty(key);
      expect(JSON.stringify(progress)).not.toContain(key);
    }
  });

  it('waits through the named login endpoint with QR refresh, session state, timeout, and abort signal', async () => {
    const controller = new AbortController();
    const progress = {
      outcome: 'progress' as const,
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      qrDataUrl: 'data:image/png;base64,qr-refresh',
      sessionKey: 'login-session-2',
    };
    hostApiFetchMock.mockResolvedValue(progress);
    const { hostChannelsLoginWait } = await import('@/lib/channel-runtime');

    await expect(hostChannelsLoginWait('openclaw-weixin', 'wechat-main', {
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
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
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

  it('uses the channel authorization endpoint for QR and link onboarding', async () => {
    const controller = new AbortController();
    hostApiFetchMock
      .mockResolvedValueOnce({ outcome: 'progress', channel: 'qqbot', sessionKey: 'auth-session-1', qrDataUrl: 'data:image/png;base64,qr' })
      .mockResolvedValueOnce({ outcome: 'connected', channel: 'qqbot', sessionKey: 'auth-session-1' })
      .mockResolvedValueOnce({ outcome: 'cancelled', channel: 'qqbot', sessionKey: 'auth-session-1' });
    const { hostChannelsCancelAuthorization, hostChannelsStartAuthorization, hostChannelsWaitAuthorization } = await import('@/lib/channel-runtime');

    await expect(hostChannelsStartAuthorization({
      channelType: 'qqbot',
      accountId: 'main',
      agentId: ' support ',
      config: { locale: 'zh' },
    }, { traceId: 'trace-auth' })).resolves.toMatchObject({ outcome: 'progress', sessionKey: 'auth-session-1' });
    await expect(hostChannelsWaitAuthorization('qqbot', 'auth-session-1', {
      traceId: 'trace-auth',
      timeoutMs: 300_000,
      signal: controller.signal,
    })).resolves.toMatchObject({ outcome: 'connected' });
    await expect(hostChannelsCancelAuthorization('qqbot', 'auth-session-1', { traceId: 'trace-auth' })).resolves.toMatchObject({ outcome: 'cancelled' });

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/channels/authorization', {
      traceId: 'trace-auth',
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: 'qqbot',
        accountId: 'main',
        agentId: 'support',
        config: { locale: 'zh' },
      }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/channels/authorization', {
      traceId: 'trace-auth',
      timeoutMs: 300_000,
      signal: controller.signal,
      method: 'POST',
      body: JSON.stringify({ action: 'wait', channel: 'qqbot', sessionKey: 'auth-session-1', timeoutMs: 300_000 }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(3, '/api/channels/authorization', {
      traceId: 'trace-auth',
      method: 'POST',
      body: JSON.stringify({ action: 'cancel', channel: 'qqbot', sessionKey: 'auth-session-1' }),
    });
  });

  it('deletes configuration through the named endpoint and preserves the account', async () => {
    const receipt = { callId: '0123456789abcdef0123456789abcdef', accepted: true };
    hostApiFetchMock.mockResolvedValue(receipt);
    getCallMock.mockResolvedValue({
      ...receipt, module: 'channels', command: 'deleteConfig', status: 'succeeded',
      start: 1, end: 2, revision: 3,
      detail: { operation: 'deleteConfig', channel: 'wecom', accountId: 'backup', phase: 'complete', outcome: 'confirmed', reply: null, configFinalization: null },
    });
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
      body: JSON.stringify({ channel: 'feishu', accountId: 'default' }),
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
