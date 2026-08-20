import { describe, expect, it, vi } from 'vitest';
import { createChannelStatusTransport } from '../../electron/main/runtime-host-delivery/transport/channels/status';

describe('Electron Main channel status transport', () => {
  it('signs and sends the fixed empty status read', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        accounts: [{ channel: 'discord', accountId: 'primary', connection: 'connected' }],
      }),
    });
    const transport = createChannelStatusTransport({ verificationKey: 'public', signDecision }, 34_124, fetcher);

    await expect(transport.read()).resolves.toEqual({
      status: 200,
      body: {
        accounts: [{ channel: 'discord', accountId: 'primary', connection: 'connected' }],
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/status',
      scope: 'channels:read',
      capability: 'channels.status.read',
      subject: 'channel-status',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34124/api/channels/status', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: '{}',
    }));
  });

  it('signs and sends the fixed snapshot operation', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-snapshot-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        ts: 1_725_000_000_000,
        channelOrder: ['discord'],
        channels: { discord: { configured: true, running: true } },
        channelAccounts: {
          discord: [{ accountId: 'primary', connected: true }],
        },
        channelDefaultAccountId: { discord: 'primary' },
      }),
    });
    const transport = createChannelStatusTransport(
      { verificationKey: 'public', signDecision },
      34_124,
      fetcher,
    );

    await expect(transport.readSnapshot()).resolves.toEqual({
      status: 200,
      body: {
        ts: 1_725_000_000_000,
        channelOrder: ['discord'],
        channels: { discord: { configured: true, running: true } },
        channelAccounts: {
          discord: [{ accountId: 'primary', connected: true }],
        },
        channelDefaultAccountId: { discord: 'primary' },
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/channels/status',
      scope: 'channels:read',
      capability: 'channels.snapshot.read',
      subject: 'channel-status',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34124/api/channels/status', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-snapshot-decision' }),
      body: '{"operation":"snapshot"}',
    }));
  });

  it('rejects malformed snapshot responses and transport failures', async () => {
    const malformed = createChannelStatusTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_124,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          ts: 1_725_000_000_000,
          channelOrder: ['discord'],
          channels: { discord: { configured: true, privateError: 'token' } },
          channelAccounts: { discord: [] },
          channelDefaultAccountId: { discord: 'primary' },
        }),
      }),
    );
    const failed = createChannelStatusTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_124,
      vi.fn().mockRejectedValue(new Error('private native failure')),
    );

    await expect(malformed.readSnapshot()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Channel status is unavailable' },
    });
    await expect(failed.readSnapshot()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Channel status is unavailable' },
    });
  });

  it('rejects inconsistent snapshots before they cross the delivery boundary', async () => {
    for (const body of [
      {
        ts: 1_725_000_000_000,
        channelOrder: ['discord'],
        channels: { slack: {} },
        channelAccounts: { discord: [] },
        channelDefaultAccountId: { discord: 'primary' },
      },
      {
        ts: 1_725_000_000_000,
        channelOrder: ['discord'],
        channels: { discord: {} },
        channelAccounts: {
          discord: [{ accountId: 'primary' }, { accountId: 'primary' }],
        },
        channelDefaultAccountId: { discord: 'primary' },
      },
      {
        ts: Number.MAX_SAFE_INTEGER + 1,
        channelOrder: ['discord'],
        channels: { discord: {} },
        channelAccounts: { discord: [] },
        channelDefaultAccountId: { discord: 'primary' },
      },
    ]) {
      const transport = createChannelStatusTransport(
        { verificationKey: 'public', signDecision: () => 'signed-decision' },
        34_124,
        vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
      );

      await expect(transport.readSnapshot()).resolves.toEqual({
        status: 503,
        body: { success: false, error: 'Channel status is unavailable' },
      });
    }
  });

  it('accepts the closed unknown connection state', async () => {
    const transport = createChannelStatusTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_124,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          accounts: [{ channel: 'slack', accountId: 'default', connection: 'unknown' }],
        }),
      }),
    );

    await expect(transport.read()).resolves.toEqual({
      status: 200,
      body: {
        accounts: [{ channel: 'slack', accountId: 'default', connection: 'unknown' }],
      },
    });
  });

  it('redacts malformed native responses and transport failures', async () => {
    const malformed = createChannelStatusTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_124,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          accounts: [{
            channel: 'discord',
            accountId: 'primary',
            connection: 'connected',
            configPath: 'C:/private/openclaw.json',
          }],
        }),
      }),
    );
    const failed = createChannelStatusTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_124,
      vi.fn().mockRejectedValue(new Error('native connection details')),
    );

    await expect(malformed.read()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Channel status is unavailable' },
    });
    const response = await failed.read();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Channel status is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('native connection details');
  });
});
