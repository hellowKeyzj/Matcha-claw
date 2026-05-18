import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Channels } from '@/pages/Channels';
import { useChannelsStore } from '@/stores/channels';

const hostChannelsActivateMock = vi.fn();
const hostChannelsCancelSessionMock = vi.fn();
const hostChannelsFetchSnapshotMock = vi.fn();
const hostChannelsProbeMock = vi.fn();
const hostChannelsReadConfigMock = vi.fn();
const hostChannelsValidateCredentialsMock = vi.fn();
const hostChannelsDeleteConfigMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsRequestQrCodeMock = vi.fn();
const hostChannelsListPairingRequestsMock = vi.fn();
const hostChannelsApprovePairingRequestMock = vi.fn();
const invokeIpcMock = vi.fn();
const subscribedHostEvents = new Map<string, Set<(payload: unknown) => void>>();

vi.mock('@/lib/channel-runtime', () => ({
  hostChannelsActivate: (...args: unknown[]) => hostChannelsActivateMock(...args),
  hostChannelsCancelSession: (...args: unknown[]) => hostChannelsCancelSessionMock(...args),
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsProbe: (...args: unknown[]) => hostChannelsProbeMock(...args),
  hostChannelsReadConfig: (...args: unknown[]) => hostChannelsReadConfigMock(...args),
  hostChannelsValidateCredentials: (...args: unknown[]) => hostChannelsValidateCredentialsMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsRequestQrCode: (...args: unknown[]) => hostChannelsRequestQrCodeMock(...args),
  hostChannelsListPairingRequests: (...args: unknown[]) => hostChannelsListPairingRequestsMock(...args),
  hostChannelsApprovePairingRequest: (...args: unknown[]) => hostChannelsApprovePairingRequestMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (eventName: string, handler: (payload: unknown) => void) => {
    const handlers = subscribedHostEvents.get(eventName) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    subscribedHostEvents.set(eventName, handlers);
    return () => {
      const currentHandlers = subscribedHostEvents.get(eventName);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        subscribedHostEvents.delete(eventName);
      }
    };
  },
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: {
    status: {
      state: string;
      gatewayReady: boolean;
      portReachable: boolean;
      gatewayRunning: boolean;
    };
    isInitialized: boolean;
  }) => unknown) => selector({
    status: {
      state: 'connected',
      gatewayReady: true,
      portReachable: true,
      gatewayRunning: true,
    },
    isInitialized: true,
  }),
}));

function emptyChannelsSnapshot() {
  return {
    success: true,
    ready: true,
    snapshot: {
      channelOrder: [],
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    },
  };
}

function feishuConfiguredSnapshot() {
  return {
    success: true,
    ready: true,
    snapshot: {
      channelOrder: ['feishu'],
      channels: {
        feishu: {
          id: 'feishu',
          type: 'feishu',
          name: 'Feishu',
          enabled: true,
          configured: true,
          connected: true,
          status: 'connected',
          accountId: 'default',
        },
      },
      channelAccounts: {
        feishu: [{
          accountId: 'default',
          configured: true,
          connected: true,
          name: 'Feishu',
        }],
      },
      channelDefaultAccountId: { feishu: 'default' },
    },
  };
}

describe('Channels page QR session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribedHostEvents.clear();
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
    hostChannelsFetchSnapshotMock.mockResolvedValue(emptyChannelsSnapshot());
    hostChannelsReadConfigMock.mockResolvedValue({ success: true, values: {} });
    hostChannelsActivateMock.mockResolvedValue({ success: true, queued: true, sessionKey: 'default' });
    hostChannelsCancelSessionMock.mockResolvedValue({ success: true });
    hostChannelsListPairingRequestsMock.mockResolvedValue({ success: true, requests: [] });
    hostChannelsApprovePairingRequestMock.mockResolvedValue({
      success: true,
      approved: { id: 'ou_user_1' },
    });
    invokeIpcMock.mockResolvedValue({ success: true });
  });

  it('查看文档打开渠道对应的本地 Markdown 文档', async () => {
    render(<Channels />);

    const weComLabel = await screen.findByText('WeCom');
    const weComButton = weComLabel.closest('button');
    expect(weComButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(weComButton as HTMLButtonElement);
    fireEvent.click(await screen.findByRole('button', { name: 'View Documentation' }));

    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith('shell:openResourcePath', 'connector-guide/wecom.md');
    });
  });

  it('收到微信二维码事件后保持登录会话，不因渠道状态事件刷新而取消', async () => {
    render(<Channels />);

    const weChatLabel = await screen.findByText('WeChat');
    const weChatButton = weChatLabel.closest('button');
    expect(weChatButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(weChatButton as HTMLButtonElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate QR Code' }));

    await waitFor(() => {
      expect(hostChannelsActivateMock).toHaveBeenCalledWith({
        channelType: 'openclaw-weixin',
        accountId: 'default',
        config: {},
      });
    });

    const channelStatusHandlers = subscribedHostEvents.get('gateway:channel-status');
    expect(channelStatusHandlers?.size).toBeGreaterThanOrEqual(2);
    const qrEvent = {
      eventName: 'channel:weixin-qr',
      payload: {
        qrDataUrl: 'data:image/png;base64,abc',
        raw: 'qr-token',
      },
    };
    act(() => {
      for (const handler of channelStatusHandlers ?? []) {
        handler(qrEvent);
      }
    });

    expect(await screen.findByAltText('WeChat login QR code')).toBeInTheDocument();
    expect(hostChannelsCancelSessionMock).not.toHaveBeenCalled();
    expect(hostChannelsFetchSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('飞书已连接时可以在页面审批用户配对码', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(feishuConfiguredSnapshot());
    hostChannelsListPairingRequestsMock.mockResolvedValue({
      success: true,
      requests: [{
        id: 'ou_user_1',
        code: 'RTHZA8EP',
        createdAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:01:00.000Z',
      }],
    });

    render(<Channels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage user binding' }));

    await waitFor(() => {
      expect(hostChannelsListPairingRequestsMock).toHaveBeenCalledWith('feishu', 'default');
    });
    expect(await screen.findByText('RTHZA8EP')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: ' RTHZA8EP ' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

    await waitFor(() => {
      expect(hostChannelsApprovePairingRequestMock).toHaveBeenCalledWith('feishu', {
        code: 'RTHZA8EP',
        accountId: 'default',
      });
    });
    expect(hostChannelsListPairingRequestsMock).toHaveBeenCalledTimes(2);
  });
});
