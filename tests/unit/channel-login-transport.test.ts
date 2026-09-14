import { describe, expect, it, vi } from 'vitest';
import { createChannelLoginTransport } from '../../electron/main/runtime-host-delivery/transport/channels/login';

describe('Electron Main channel login transport', () => {
  it('sends a signed start request and accepts only the sealed connected response shape', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const body = {
      outcome: 'connected' as const,
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      sessionKey: 'login-session-connected',
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createChannelLoginTransport({ verificationKey: 'public', signDecision }, 32_140, fetcher);
    const input = {
      action: 'start' as const,
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      force: true,
      config: {},
    };

    await expect(transport.login(input, '12345678-1234-4234-8234-123456789abc')).resolves.toEqual({ status: 200, body });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/login',
      scope: 'channels:write',
      capability: 'channels.login',
      subject: 'channel-login',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32140/api/channels/login', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision', 'X-MatchaClaw-Session-Trace': '12345678-1234-4234-8234-123456789abc' }),
      body: JSON.stringify(input),
    }));
    expect(Object.keys(body).sort()).toEqual(['accountId', 'channel', 'outcome', 'sessionKey']);
  });

  it('fails closed when native response fields try to cross the public boundary', async () => {
    const transport = createChannelLoginTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      32_140,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          outcome: 'connected',
          channel: 'openclaw-weixin',
          accountId: 'wechat-main',
          sessionKey: 'login-session-connected',
          directLogin: true,
          alreadyConnected: true,
          token: 'native-token',
          message: 'native message',
        }),
      }),
    );

    await expect(transport.login({
      action: 'start',
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
    })).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
  });

  it('rejects native request fields before signing or sending', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createChannelLoginTransport({ verificationKey: 'public', signDecision }, 32_140, fetcher);

    await expect(transport.login({
      action: 'start',
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      directLogin: true,
    } as never)).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });

    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
