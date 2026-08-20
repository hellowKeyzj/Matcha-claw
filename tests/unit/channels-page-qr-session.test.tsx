import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Channels } from '@/pages/Channels';
import { useChannelsStore } from '@/stores/channels';

const hostChannelsActivateMock = vi.fn();
const hostChannelsApprovePairingRequestMock = vi.fn();
const hostChannelsCancelSessionMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDeleteConfigMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsFetchSnapshotMock = vi.fn();
const hostChannelsListPairingRequestsMock = vi.fn();
const hostChannelsLoginWaitMock = vi.fn();
const hostChannelsProbeMock = vi.fn();
const hostChannelsReadConfigMock = vi.fn();
const hostChannelsValidateCredentialsMock = vi.fn();

vi.mock('@/lib/channel-runtime', () => ({
  hostChannelsActivate: (...args: unknown[]) => hostChannelsActivateMock(...args),
  hostChannelsApprovePairingRequest: (...args: unknown[]) => hostChannelsApprovePairingRequestMock(...args),
  hostChannelsCancelSession: (...args: unknown[]) => hostChannelsCancelSessionMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsListPairingRequests: (...args: unknown[]) => hostChannelsListPairingRequestsMock(...args),
  hostChannelsLoginWait: (...args: unknown[]) => hostChannelsLoginWaitMock(...args),
  hostChannelsProbe: (...args: unknown[]) => hostChannelsProbeMock(...args),
  hostChannelsReadConfig: (...args: unknown[]) => hostChannelsReadConfigMock(...args),
  hostChannelsValidateCredentials: (...args: unknown[]) => hostChannelsValidateCredentialsMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: vi.fn(() => () => { }),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
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
    hostChannelsFetchSnapshotMock.mockResolvedValue(emptySnapshot());
    hostChannelsReadConfigMock.mockResolvedValue({ success: true, values: {} });
    hostChannelsValidateCredentialsMock.mockResolvedValue({ success: true, valid: true });
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
    hostChannelsCancelSessionMock.mockResolvedValue({ outcome: 'cancelled' });
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsConnectMock.mockResolvedValue({ success: true });
    hostChannelsDisconnectMock.mockResolvedValue({ success: true });
    hostChannelsListPairingRequestsMock.mockResolvedValue({ success: true, requests: [] });
    hostChannelsApprovePairingRequestMock.mockResolvedValue({ success: true });
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
        accountId: 'default',
        qrDataUrl: 'data:image/png;base64,qr-refresh',
        sessionKey: 'session-refresh',
      })
      .mockReturnValueOnce(connectedPromise);

    render(<Channels />);

    expect(await screen.findByText('Available Channels')).toBeInTheDocument();
    clickAvailableChannel('WeChat');
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));

    await waitFor(() => {
      expect(hostChannelsActivateMock).toHaveBeenCalledWith({
        channelType: 'openclaw-weixin',
        accountId: 'default',
        config: {},
      });
      expect(hostChannelsLoginWaitMock).toHaveBeenCalledTimes(2);
    });

    expect(hostChannelsLoginWaitMock.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 300_000,
      sessionKey: 'session-start',
      currentQrDataUrl: 'data:image/png;base64,qr-start',
      signal: expect.any(AbortSignal),
    });
    expect(hostChannelsLoginWaitMock.mock.calls[1]?.[2]).toMatchObject({
      timeoutMs: 300_000,
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
      accountId: 'default',
      sessionKey: 'session-connected',
    });
    await waitFor(() => {
      expect(screen.queryByAltText('WeChat login QR code')).not.toBeInTheDocument();
    });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));
    await screen.findByAltText('WeChat login QR code');
    await waitFor(() => expect(hostChannelsLoginWaitMock).toHaveBeenCalledTimes(1));

    const closeButton = screen.getAllByRole('button').find((button) => !button.textContent?.trim());
    expect(closeButton).toBeDefined();
    fireEvent.click(closeButton as HTMLButtonElement);

    await waitFor(() => {
      expect(waitSignal?.aborted).toBe(true);
      expect(hostChannelsCancelSessionMock).toHaveBeenCalledWith('openclaw-weixin', 'default');
    });
  });

  it('keeps a configured channel when deletion is not confirmed', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(configuredFeishuSnapshot());
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'unknown' });

    render(<Channels />);

    expect(await screen.findByText('Configured Channels')).toBeInTheDocument();
    const deleteButton = document.querySelector('button.text-destructive');
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(deleteButton as HTMLButtonElement);
    expect(screen.getByText('Are you sure you want to delete this channel?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('feishu', 'default');
    });
    expect(useChannelsStore.getState().channels[0]).toMatchObject({
      type: 'feishu',
      accountId: 'default',
      status: 'connected',
    });
  });
});
