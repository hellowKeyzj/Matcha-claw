import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Channels } from '@/pages/Channels';
import { useChannelsStore } from '@/stores/channels';
import { useSubagentsStore } from '@/stores/subagents';

const hostChannelsActivateMock = vi.fn();
const hostChannelsConfigureMock = vi.fn();
const hostChannelsApprovePairingRequestMock = vi.fn();
const hostChannelsCancelAuthorizationMock = vi.fn();
const hostChannelsCancelSessionMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDeleteConfigMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsFetchSnapshotMock = vi.fn();
const hostChannelsListPairingRequestsMock = vi.fn();
const hostChannelsLoginWaitMock = vi.fn();
const hostChannelsProbeMock = vi.fn();
const hostChannelsReadConfigMock = vi.fn();
const hostChannelsStartAuthorizationMock = vi.fn();
const hostChannelsValidateCredentialsMock = vi.fn();
const hostChannelsWaitAuthorizationMock = vi.fn();
const invokeIpcMock = vi.fn();

vi.mock('@/lib/channel-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/channel-runtime')>(),
  hostChannelsActivate: (...args: unknown[]) => hostChannelsActivateMock(...args),
  hostChannelsConfigure: (...args: unknown[]) => hostChannelsConfigureMock(...args),
  hostChannelsApprovePairingRequest: (...args: unknown[]) => hostChannelsApprovePairingRequestMock(...args),
  hostChannelsCancelAuthorization: (...args: unknown[]) => hostChannelsCancelAuthorizationMock(...args),
  hostChannelsCancelSession: (...args: unknown[]) => hostChannelsCancelSessionMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsListPairingRequests: (...args: unknown[]) => hostChannelsListPairingRequestsMock(...args),
  hostChannelsLoginWait: (...args: unknown[]) => hostChannelsLoginWaitMock(...args),
  hostChannelsProbe: (...args: unknown[]) => hostChannelsProbeMock(...args),
  hostChannelsReadConfig: (...args: unknown[]) => hostChannelsReadConfigMock(...args),
  hostChannelsStartAuthorization: (...args: unknown[]) => hostChannelsStartAuthorizationMock(...args),
  hostChannelsValidateCredentials: (...args: unknown[]) => hostChannelsValidateCredentialsMock(...args),
  hostChannelsWaitAuthorization: (...args: unknown[]) => hostChannelsWaitAuthorizationMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: vi.fn(() => () => { }),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: {
    status: {
      processState: string;
      transportState: string;
      gatewayReady: boolean;
      healthSummary: string;
      portReachable: boolean;
      diagnostics: { consecutiveHeartbeatMisses: number; consecutiveRpcFailures: number };
    };
    isInitialized: boolean;
  }) => unknown) => selector({
    status: {
      processState: 'running',
      transportState: 'connected',
      gatewayReady: true,
      healthSummary: 'healthy',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
    },
    isInitialized: true,
  }),
}));

function snapshot(channels: Record<string, unknown>, channelAccounts: Record<string, unknown[]>) {
  return {
    success: true,
    ready: true,
    snapshot: {
      channelOrder: Object.keys(channels),
      channels,
      channelAccounts,
      channelDefaultAccountId: Object.fromEntries(Object.keys(channels).map((channel) => [channel, 'default'])),
    },
  };
}

function emptySnapshot() {
  return snapshot({}, {});
}

function configuredFeishuSnapshot() {
  return snapshot(
    { feishu: { configured: true } },
    { feishu: [{ accountId: 'default', configured: true, connected: true, name: 'Feishu' }] },
  );
}

function configuredTelegramSnapshot() {
  return snapshot(
    { telegram: { configured: true } },
    { telegram: [{ accountId: 'default', configured: true, connected: false, name: 'Telegram Bot' }] },
  );
}

function configuredWeixinSnapshot() {
  return snapshot(
    { 'openclaw-weixin': { configured: true } },
    { 'openclaw-weixin': [{ accountId: '117f95be58a5-im-bot', configured: true, connected: true, name: 'WeChat' }] },
  );
}

function clickAvailableChannel(name: string) {
  const label = screen.getByText(name, { exact: true });
  const button = label.closest('button');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  fireEvent.click(button as HTMLButtonElement);
}

describe('Channels page QR session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
    useChannelsStore.setState({
      channels: [],
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingByChannelId: {},
      error: null,
    });
    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'main', isDefault: true },
          { id: 'support', name: 'Support' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: Date.now(),
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);
    hostChannelsFetchSnapshotMock.mockResolvedValue(emptySnapshot());
    hostChannelsReadConfigMock.mockResolvedValue({ success: true, values: {} });
    hostChannelsValidateCredentialsMock.mockResolvedValue({ success: true, valid: true });
    hostChannelsConfigureMock.mockResolvedValue({ success: true });
    hostChannelsActivateMock.mockResolvedValue({
      success: true,
      progress: {
        outcome: 'progress',
        channel: 'openclaw-weixin',
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,qr-start',
        sessionKey: 'session-start',
      },
    });
    hostChannelsStartAuthorizationMock.mockResolvedValue({
      outcome: 'progress',
      channel: 'qqbot',
      accountId: 'default',
      qrDataUrl: 'data:image/png;base64,auth-qr-start',
      sessionKey: 'auth-session-start',
    });
    hostChannelsWaitAuthorizationMock.mockResolvedValue({
      outcome: 'connected',
      channel: 'qqbot',
      accountId: 'default',
      sessionKey: 'auth-session-start',
    });
    hostChannelsCancelAuthorizationMock.mockResolvedValue({ outcome: 'cancelled', channel: 'qqbot' });
    hostChannelsCancelSessionMock.mockResolvedValue({ outcome: 'cancelled' });
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsConnectMock.mockResolvedValue({ success: true });
    hostChannelsDisconnectMock.mockResolvedValue({ success: true });
    hostChannelsListPairingRequestsMock.mockResolvedValue({ success: true, requests: [] });
    hostChannelsApprovePairingRequestMock.mockResolvedValue({ success: true });
  });

  it('shows only the current configurable channel catalog by default', async () => {
    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    for (const name of ['WeChat', 'QQ Bot', 'DingTalk', 'WeCom', 'Feishu / Lark']) {
      expect(screen.getByText(name, { exact: true })).toBeInTheDocument();
    }
    for (const name of ['Telegram', 'Discord', 'WhatsApp', 'Signal', 'Matrix', 'LINE', 'Microsoft Teams', 'Google Chat', 'Mattermost']) {
      expect(screen.queryByText(name, { exact: true })).not.toBeInTheDocument();
    }
  });

  it('shows an existing legacy config without adding it to the available catalog', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(configuredTelegramSnapshot());

    render(<Channels />);

    expect(await screen.findByText('Configured Channels')).toBeInTheDocument();
    expect(screen.getByText('Telegram Bot')).toBeInTheDocument();
    expect(screen.getAllByText('Telegram')).toHaveLength(2);
    expect(screen.getByText('Available Channels')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Telegram$/ })).not.toBeInTheDocument();
  });

  it('starts QR login, applies refreshed QR and returned sessionKey, then completes when connected', async () => {
    let resolveConnected: ((value: {
      outcome: 'connected';
      channel: string;
      accountId: string;
      sessionKey: string;
    }) => void) | undefined;
    const connectedPromise = new Promise<{
      outcome: 'connected';
      channel: string;
      accountId: string;
      sessionKey: string;
    }>((resolve) => {
      resolveConnected = resolve;
    });
    hostChannelsLoginWaitMock
      .mockResolvedValueOnce({
        outcome: 'progress',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        qrDataUrl: 'data:image/png;base64,qr-refresh',
        sessionKey: 'session-refresh',
      })
      .mockReturnValueOnce(connectedPromise);

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeChat');
    fireEvent.change(await screen.findByLabelText('Channel Name'), { target: { value: 'wechat-main' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));

    await waitFor(() => {
      expect(hostChannelsActivateMock).toHaveBeenCalledWith({
        channelType: 'openclaw-weixin',
        accountId: 'wechat-main',
        config: {},
      }, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
      expect(hostChannelsLoginWaitMock).toHaveBeenCalledTimes(2);
    });

    expect(hostChannelsLoginWaitMock.mock.calls[0]?.slice(0, 2)).toEqual(['openclaw-weixin', 'wechat-main']);
    expect(hostChannelsLoginWaitMock.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 300_000,
      traceId: hostChannelsActivateMock.mock.calls[0]?.[1]?.traceId,
      sessionKey: 'session-start',
      currentQrDataUrl: 'data:image/png;base64,qr-start',
      signal: expect.any(AbortSignal),
    });
    expect(hostChannelsLoginWaitMock.mock.calls[1]?.slice(0, 2)).toEqual(['openclaw-weixin', 'wechat-main']);
    expect(hostChannelsLoginWaitMock.mock.calls[1]?.[2]).toMatchObject({
      timeoutMs: 300_000,
      traceId: hostChannelsActivateMock.mock.calls[0]?.[1]?.traceId,
      sessionKey: 'session-refresh',
      currentQrDataUrl: 'data:image/png;base64,qr-refresh',
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByAltText('WeChat login QR code')).toHaveAttribute(
      'src',
      'data:image/png;base64,qr-refresh',
    );

    resolveConnected?.({
      outcome: 'connected',
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      sessionKey: 'session-connected',
    });
    await waitFor(() => {
      expect(screen.queryByAltText('WeChat login QR code')).not.toBeInTheDocument();
    });
  });

  it('starts QQ Bot authorization, refreshes QR, and completes without returning secrets', async () => {
    let resolveConnected: ((value: {
      outcome: 'connected';
      channel: string;
      accountId: string;
      sessionKey: string;
    }) => void) | undefined;
    const connectedPromise = new Promise<{
      outcome: 'connected';
      channel: string;
      accountId: string;
      sessionKey: string;
    }>((resolve) => {
      resolveConnected = resolve;
    });
    hostChannelsStartAuthorizationMock.mockResolvedValueOnce({
      outcome: 'progress',
      channel: 'qqbot',
      accountId: 'default',
      qrDataUrl: 'data:image/png;base64,auth-qr-start',
      sessionKey: 'auth-session-start',
    });
    hostChannelsWaitAuthorizationMock
      .mockResolvedValueOnce({
        outcome: 'progress',
        channel: 'qqbot',
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,auth-qr-refresh',
        sessionKey: 'auth-session-refresh',
      })
      .mockReturnValueOnce(connectedPromise);

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('QQ Bot');
    expect(await screen.findByRole('button', { name: 'Scan / authorize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use configuration' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start authorization' }));

    await waitFor(() => {
      expect(hostChannelsStartAuthorizationMock).toHaveBeenCalledTimes(1);
      expect(hostChannelsWaitAuthorizationMock).toHaveBeenCalledTimes(2);
    });
    expect(hostChannelsStartAuthorizationMock.mock.calls[0]?.[0]).toEqual({
      channelType: 'qqbot',
      accountId: 'default',
      config: {},
    });
    expect(hostChannelsStartAuthorizationMock.mock.calls[0]?.[1]?.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(hostChannelsWaitAuthorizationMock.mock.calls[0]?.slice(0, 2)).toEqual(['qqbot', 'auth-session-start']);
    expect(hostChannelsWaitAuthorizationMock.mock.calls[0]?.[2]).toMatchObject({
      traceId: hostChannelsStartAuthorizationMock.mock.calls[0]?.[1]?.traceId,
      timeoutMs: 300_000,
      signal: expect.any(AbortSignal),
    });
    expect(hostChannelsWaitAuthorizationMock.mock.calls[1]?.slice(0, 2)).toEqual(['qqbot', 'auth-session-refresh']);
    expect(hostChannelsWaitAuthorizationMock.mock.calls[1]?.[2]).toMatchObject({
      traceId: hostChannelsStartAuthorizationMock.mock.calls[0]?.[1]?.traceId,
      timeoutMs: 300_000,
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByAltText('QQ Bot login QR code')).toHaveAttribute(
      'src',
      'data:image/png;base64,auth-qr-refresh',
    );
    expect(JSON.stringify(hostChannelsStartAuthorizationMock.mock.calls)).not.toContain('clientSecret');

    resolveConnected?.({
      outcome: 'connected',
      channel: 'qqbot',
      accountId: 'default',
      sessionKey: 'auth-session-connected',
    });
    await waitFor(() => {
      expect(screen.queryByAltText('QQ Bot login QR code')).not.toBeInTheDocument();
    });
  });

  it.each([
    ['QQ Bot', 'qqbot', 'QQ Bot login QR code'],
    ['DingTalk', 'dingtalk', 'DingTalk login QR code'],
    ['Feishu / Lark', 'feishu', 'Feishu / Lark login QR code'],
  ] as const)('cancels the active %s authorization session before refreshing QR authorization', async (name, channelType, qrAlt) => {
    hostChannelsStartAuthorizationMock
      .mockResolvedValueOnce({
        outcome: 'progress',
        channel: channelType,
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,auth-qr-start',
        sessionKey: 'auth-session-start',
      })
      .mockResolvedValueOnce({
        outcome: 'progress',
        channel: channelType,
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,auth-qr-next',
        sessionKey: 'auth-session-next',
      });
    hostChannelsWaitAuthorizationMock
      .mockImplementationOnce((_channel: unknown, _sessionKey: unknown, options: { signal?: AbortSignal }) => new Promise((resolve) => {
        options.signal?.addEventListener('abort', () => {
          resolve({ outcome: 'cancelled', channel: channelType, sessionKey: 'auth-session-start' });
        }, { once: true });
      }))
      .mockReturnValueOnce(new Promise(() => { }));

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel(name);
    fireEvent.click(await screen.findByRole('button', { name: 'Start authorization' }));
    await screen.findByAltText(qrAlt);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh QR code' }));

    await waitFor(() => {
      expect(hostChannelsCancelAuthorizationMock).toHaveBeenCalledWith(channelType, 'auth-session-start', { traceId: hostChannelsStartAuthorizationMock.mock.calls[0]?.[1]?.traceId });
      expect(hostChannelsStartAuthorizationMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByAltText(qrAlt)).toHaveAttribute('src', 'data:image/png;base64,auth-qr-next');
  });

  it('starts Feishu link authorization and opens the public authorization URL', async () => {
    hostChannelsStartAuthorizationMock.mockResolvedValueOnce({
      outcome: 'progress',
      channel: 'feishu',
      accountId: 'default',
      authorizationUrl: 'https://accounts.feishu.cn/oauth/v1/app/registration?token=public',
      sessionKey: 'auth-session-start',
    });
    hostChannelsWaitAuthorizationMock.mockReturnValueOnce(new Promise(() => { }));

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('Feishu / Lark');
    expect(await screen.findByRole('button', { name: 'Scan / authorize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use configuration' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start authorization' }));

    expect(await screen.findByRole('button', { name: 'Open authorization link' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization link' }));

    expect(hostChannelsStartAuthorizationMock).toHaveBeenCalledWith({
      channelType: 'feishu',
      accountId: 'default',
      config: {},
    }, { traceId: expect.any(String) });
    expect(invokeIpcMock).toHaveBeenCalledWith('shell:openExternal', 'https://accounts.feishu.cn/oauth/v1/app/registration?token=public');
    expect(JSON.stringify(hostChannelsStartAuthorizationMock.mock.calls)).not.toContain('appSecret');
  });

  it('saves QQ Bot credentials when configuration mode is selected', async () => {
    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('QQ Bot');
    fireEvent.click(await screen.findByRole('button', { name: 'Use configuration' }));
    fireEvent.change(await screen.findByLabelText(/App ID/), { target: { value: 'qq-app-1' } });
    fireEvent.change(await screen.findByLabelText(/Client Secret/), { target: { value: 'qq-secret-1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save & Connect' }));

    await waitFor(() => {
      expect(hostChannelsConfigureMock).toHaveBeenCalledWith({
        channelType: 'qqbot',
        accountId: 'default',
        config: {
          appId: 'qq-app-1',
          clientSecret: 'qq-secret-1',
        },
      }, { traceId: expect.any(String) });
    });
    expect(hostChannelsStartAuthorizationMock).not.toHaveBeenCalled();
    expect(hostChannelsActivateMock).not.toHaveBeenCalled();
  });

  it('keeps WeCom on credential configuration instead of authorization', async () => {
    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeCom');
    expect(screen.queryByRole('button', { name: 'Scan / authorize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use configuration' })).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText(/Bot ID/), { target: { value: 'bot-1' } });
    fireEvent.change(await screen.findByLabelText(/Bot Secret/), { target: { value: 'secret-1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save & Connect' }));

    await waitFor(() => {
      expect(hostChannelsValidateCredentialsMock).toHaveBeenCalledWith('wecom', {
        botId: 'bot-1',
        secret: 'secret-1',
      }, { traceId: expect.any(String) });
      expect(hostChannelsConfigureMock).toHaveBeenCalledWith({
        channelType: 'wecom',
        accountId: 'default',
        config: {
          botId: 'bot-1',
          secret: 'secret-1',
        },
      }, { traceId: expect.any(String) });
    });
    expect(hostChannelsStartAuthorizationMock).not.toHaveBeenCalled();
    expect(hostChannelsActivateMock).not.toHaveBeenCalled();
  });

  it('completes Weixin direct login without wait, cancel, or QR display', async () => {
    hostChannelsActivateMock.mockResolvedValue({
      success: true,
      progress: {
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        sessionKey: 'login-session-connected',
      },
    });
    const snapshotCallCountBeforeLogin = hostChannelsFetchSnapshotMock.mock.calls.length;

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeChat');
    fireEvent.change(await screen.findByLabelText('Channel Name'), { target: { value: 'wechat-main' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));

    await waitFor(() => {
      expect(hostChannelsActivateMock).toHaveBeenCalledWith({
        channelType: 'openclaw-weixin',
        accountId: 'wechat-main',
        config: {},
      }, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
      expect(hostChannelsFetchSnapshotMock.mock.calls.length - snapshotCallCountBeforeLogin).toBeGreaterThanOrEqual(2);
    });
    expect(hostChannelsLoginWaitMock).not.toHaveBeenCalled();
    expect(hostChannelsCancelSessionMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText('WeChat login QR code')).not.toBeInTheDocument();
  });

  it('updates a configured Weixin agent without starting QR login', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(configuredWeixinSnapshot());

    render(<Channels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Configure WeChat' }));
    await waitFor(() => expect([...(screen.getByLabelText('Agent') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'main', 'support']));
    const agentSelect = screen.getByLabelText('Agent') as HTMLSelectElement;
    fireEvent.change(agentSelect, { target: { value: 'support' } });
    expect(agentSelect.value).toBe('support');
    fireEvent.click(await screen.findByRole('button', { name: 'Update & Reconnect' }));

    await waitFor(() => {
      expect(hostChannelsConfigureMock).toHaveBeenCalledWith({
        channelType: 'openclaw-weixin',
        accountId: '117f95be58a5-im-bot',
        agentId: 'support',
        config: {},
      }, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
    });
    expect(hostChannelsReadConfigMock).toHaveBeenCalledWith('openclaw-weixin', '117f95be58a5-im-bot', { traceId: expect.any(String) });
    expect(hostChannelsActivateMock).not.toHaveBeenCalled();
    expect(hostChannelsLoginWaitMock).not.toHaveBeenCalled();
    expect(hostChannelsCancelSessionMock).not.toHaveBeenCalled();
  });

  it('updates a configured token channel agent without credential validation', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(configuredFeishuSnapshot());

    render(<Channels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Configure Feishu' }));
    await waitFor(() => expect([...(screen.getByLabelText('Agent') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'main', 'support']));
    const agentSelect = screen.getByLabelText('Agent') as HTMLSelectElement;
    fireEvent.change(agentSelect, { target: { value: 'support' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Update & Reconnect' }));

    await waitFor(() => {
      expect(hostChannelsConfigureMock).toHaveBeenCalledWith({
        channelType: 'feishu',
        accountId: 'default',
        agentId: 'support',
        config: {},
      }, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
    });
    expect(hostChannelsValidateCredentialsMock).not.toHaveBeenCalled();
    expect(hostChannelsActivateMock).not.toHaveBeenCalled();
  });

  it('continues QR wait when Gateway progress omits sessionKey', async () => {
    hostChannelsActivateMock.mockResolvedValue({
      success: true,
      progress: {
        outcome: 'progress',
        channel: 'openclaw-weixin',
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,qr-start',
      },
    });
    hostChannelsLoginWaitMock
      .mockResolvedValueOnce({
        outcome: 'progress',
        channel: 'openclaw-weixin',
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,qr-refresh',
      })
      .mockResolvedValueOnce({
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'default',
      });

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeChat');
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));

    await waitFor(() => expect(hostChannelsLoginWaitMock).toHaveBeenCalledTimes(2));
    expect(hostChannelsLoginWaitMock.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 300_000,
      currentQrDataUrl: 'data:image/png;base64,qr-start',
      signal: expect.any(AbortSignal),
    });
    expect(hostChannelsLoginWaitMock.mock.calls[0]?.[2]?.sessionKey).toBeUndefined();
    expect(hostChannelsLoginWaitMock.mock.calls[1]?.[2]).toMatchObject({
      timeoutMs: 300_000,
      currentQrDataUrl: 'data:image/png;base64,qr-refresh',
      signal: expect.any(AbortSignal),
    });
    expect(hostChannelsLoginWaitMock.mock.calls[1]?.[2]?.sessionKey).toBeUndefined();
  });

  it('aborts the local wait and cancels the session when the QR dialog closes', async () => {
    let waitSignal: AbortSignal | undefined;
    hostChannelsLoginWaitMock.mockImplementation((_channel: unknown, _accountId: unknown, options: { signal?: AbortSignal }) => {
      waitSignal = options.signal;
      return new Promise(() => { });
    });

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeChat');
    fireEvent.change(await screen.findByLabelText('Channel Name'), { target: { value: 'wechat-main' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));
    await screen.findByAltText('WeChat login QR code');
    await waitFor(() => expect(hostChannelsLoginWaitMock).toHaveBeenCalledTimes(1));

    const closeButton = screen.getAllByRole('button').find((button) => !button.textContent?.trim());
    expect(closeButton).toBeDefined();
    fireEvent.click(closeButton as HTMLButtonElement);

    await waitFor(() => {
      expect(waitSignal?.aborted).toBe(true);
      expect(hostChannelsCancelSessionMock).toHaveBeenCalledWith('openclaw-weixin', 'wechat-main', { traceId: hostChannelsActivateMock.mock.calls[0]?.[1]?.traceId });
    });
  });

  it('does not restore a deleted channel when the confirmed refresh snapshot has no configured account', async () => {
    let nowMs = 1_000;
    const dateNowMock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    hostChannelsFetchSnapshotMock
      .mockResolvedValueOnce(configuredFeishuSnapshot())
      .mockResolvedValue(emptySnapshot());
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });

    try {
      render(<Channels />);

      expect(await screen.findByText('Configured Channels')).toBeInTheDocument();
      expect(screen.getByText('Feishu', { exact: true })).toBeInTheDocument();
      nowMs = 3_000;
      const deleteButton = document.querySelector('button.text-destructive');
      expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
      fireEvent.click(deleteButton as HTMLButtonElement);
      expect(screen.getByText('Are you sure you want to delete this channel?')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('feishu', undefined, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
        expect(hostChannelsFetchSnapshotMock).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByText('Configured Channels')).not.toBeInTheDocument();
      expect(screen.queryByText('Feishu', { exact: true })).not.toBeInTheDocument();
    } finally {
      dateNowMock.mockRestore();
    }
  });

  it.each([
    ['target_rejected'],
    ['unknown'],
  ] as const)('keeps a configured channel and shows the item error when deletion is %s', async (outcome) => {
    let nowMs = 1_000;
    const dateNowMock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    hostChannelsFetchSnapshotMock
      .mockResolvedValueOnce(configuredFeishuSnapshot())
      .mockResolvedValue(emptySnapshot());
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome });

    try {
      render(<Channels />);

      expect(await screen.findByText('Configured Channels')).toBeInTheDocument();
      nowMs = 3_000;
      const deleteButton = document.querySelector('button.text-destructive');
      expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
      fireEvent.click(deleteButton as HTMLButtonElement);
      expect(screen.getByText('Are you sure you want to delete this channel?')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('feishu', undefined, { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
        expect(screen.queryByText('Are you sure you want to delete this channel?')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Feishu', { exact: true })).toBeInTheDocument();
      expect(screen.getByText(`Channel deletion outcome was ${outcome}`)).toBeInTheDocument();
    } finally {
      dateNowMock.mockRestore();
    }
  });
});
