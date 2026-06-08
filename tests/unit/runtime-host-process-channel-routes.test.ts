import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '../../runtime-host/api/routes/channel-routes';
import { createChannelIntegrationCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/integration/channel-integration-capability';
import { ChannelService } from '../../runtime-host/application/channels/service';
import { ChannelActivationWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-activation-workflow';
import { ChannelConfigMutationWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-config-mutation-workflow';
import { ChannelRuntimeWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-runtime-workflow';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import type { CapabilityOperationContext } from '../../runtime-host/application/capabilities/contracts/capability-router';
import type { CapabilityTarget, RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const clock = {
  nowMs: () => 1234,
  nowIso: () => '1970-01-01T00:00:01.234Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

async function dispatchChannelIntegrationCapability(
  channelService: ChannelService,
  operationId: string,
  payload: Record<string, unknown> = {},
  target: CapabilityTarget | null = channelCapabilityTarget(operationId, payload),
) {
  const route = createChannelIntegrationCapabilityOperationRoutes({ channelService })
    .find((candidate) => candidate.operationId === operationId);
  if (!route) {
    throw new Error(`Missing channel integration operation: ${operationId}`);
  }
  return await route.handle(channelIntegrationContext(operationId, payload, target));
}

const channelRuntimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: openClawTestRuntimeEndpoint,
};

function channelCapabilityTarget(operationId: string, payload: Record<string, unknown>): CapabilityTarget | null {
  if (operationId === 'channels.probe') {
    return null;
  }
  if (operationId === 'channels.cancelSession' || operationId === 'channels.requestQr' || operationId === 'channels.approvePairing') {
    return channelPairingTarget(payload);
  }
  return channelTarget(payload);
}

function channelTarget(payload: Record<string, unknown>): CapabilityTarget {
  const channelType = typeof payload.channelType === 'string' ? payload.channelType : '';
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
  return { kind: 'channel', channelType, ...(accountId ? { accountId } : {}) };
}

function channelPairingTarget(payload: Record<string, unknown>): CapabilityTarget {
  const channelType = typeof payload.channelType === 'string' ? payload.channelType : '';
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
  const pairingId = typeof payload.code === 'string' ? payload.code.trim() : undefined;
  return { kind: 'channel-pairing', channelType, ...(accountId ? { accountId } : {}), ...(pairingId ? { pairingId } : {}) };
}

function channelIntegrationContext(
  operationId: string,
  payload: Record<string, unknown>,
  target: CapabilityTarget | null,
): CapabilityOperationContext {
  return {
    capabilityId: 'integration.channel',
    operationId,
    scope: channelRuntimeScope,
    target,
    input: payload,
    domainInput: payload,
  };
}

function createDeps() {
  const deps = {
    openclawBridge: {
      channelsStatus: vi.fn(async () => ({ status: 'ok' })),
      channelsConnect: vi.fn(async () => ({ success: true })),
      channelsDisconnect: vi.fn(async () => ({ success: true })),
      channelsRequestQr: vi.fn(async () => ({ qrCode: 'qr-code', sessionId: 'session-1' })),
      readGatewayConnectionState: vi.fn(async () => ({
        state: 'connected',
        gatewayReady: true,
        portReachable: true,
      })),
    },
    listConfiguredChannels: vi.fn(async () => []),
    validateChannelConfig: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    validateChannelCredentials: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    prepareChannelPlugin: vi.fn(async () => {}),
    requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: { success: true } })),
    mapParentTransportResponse: vi.fn((upstream: unknown) => ({ status: 200, data: upstream })),
    submitActivateDirectChannel: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-activate',
        type: 'channels.activateDirect',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitRefreshSnapshot: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-refresh',
        type: 'channels.refreshSnapshot',
        status: 'queued',
        queuedAt: 0,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitProbeSnapshot: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-probe',
        type: 'channels.probeSnapshot',
        status: 'queued',
        queuedAt: 2,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitDeleteChannelConfig: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-delete',
        type: 'channels.deleteConfig',
        status: 'queued',
        queuedAt: 3,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    saveChannelConfig: vi.fn(async () => {}),
    getChannelFormValues: vi.fn(async () => ({})),
    deleteChannelConfig: vi.fn(async () => {}),
    listPairingRequests: vi.fn(async () => ({
      success: true,
      requests: [{
        id: 'ou_user_1',
        code: 'RTHZA8EP',
        createdAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:01:00.000Z',
        meta: { name: 'Alice' },
      }],
    })),
    approvePairingRequest: vi.fn(async (input: { code: string }) => ({
      success: true,
      approved: {
        id: 'ou_user_1',
        entry: {
          id: 'ou_user_1',
          code: input.code,
          createdAt: '2026-05-18T00:00:00.000Z',
          lastSeenAt: '2026-05-18T00:01:00.000Z',
        },
      },
    })),
    startLoginSession: vi.fn(async (input: { channelType: string; accountId?: string }) => ({
      queued: true as const,
      sessionKey: input.accountId || input.channelType,
    })),
    cancelLoginSession: vi.fn(async () => {}),
  };
  const channelConfig = {
    listConfiguredChannels: deps.listConfiguredChannels,
    validateChannelConfig: deps.validateChannelConfig,
    validateChannelCredentials: deps.validateChannelCredentials,
    prepareChannelPlugin: deps.prepareChannelPlugin,
    saveChannelConfig: deps.saveChannelConfig,
    getChannelFormValues: deps.getChannelFormValues,
    deleteChannelConfig: deps.deleteChannelConfig,
  };
  const parentShell = {
    request: deps.requestParentShellAction,
    mapResponse: deps.mapParentTransportResponse,
  };
  const configMutationWorkflow = new ChannelConfigMutationWorkflow({
    channelConfig,
    parentShell,
  });
  const runtimeWorkflow = new ChannelRuntimeWorkflow({
    gateway: deps.openclawBridge,
    channelConfig,
    clock,
  });
  const jobs = {
    submitRefreshSnapshot: deps.submitRefreshSnapshot,
    submitProbeSnapshot: deps.submitProbeSnapshot,
    submitActivateDirectChannel: deps.submitActivateDirectChannel,
    submitDeleteChannelConfig: deps.submitDeleteChannelConfig,
  };
  const loginSessions = {
    start: deps.startLoginSession,
    cancel: deps.cancelLoginSession,
  };
  const activationStrategy = {
    resolveChannelActivationMode: (channelType: string) => (
      channelType === 'whatsapp' || channelType === 'openclaw-weixin'
        ? 'login-session' as const
        : 'direct-config' as const
    ),
  };
  const activationWorkflow = new ChannelActivationWorkflow({
    channelConfig,
    loginSessions,
    jobs,
    activationStrategy,
  });
  return {
    ...deps,
    routeDeps: {
      channelService: new ChannelService({
        channelConfig,
        activationWorkflow,
        configMutationWorkflow,
        runtimeWorkflow,
        pairing: {
          listRequests: deps.listPairingRequests,
          approveRequest: deps.approvePairingRequest,
        },
        jobs,
      }),
    },
  };
}

describe('runtime-host process channel routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('snapshot 在 Gateway 未 ready 时只返回未就绪状态，不提交刷新任务', async () => {
    const deps = createDeps();
    deps.openclawBridge.readGatewayConnectionState.mockResolvedValueOnce({
      state: 'disconnected',
      gatewayReady: false,
      portReachable: false,
    });

    const snapshotResult = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps.routeDeps,
    );

    expect(deps.submitRefreshSnapshot).not.toHaveBeenCalled();
    expect(deps.openclawBridge.channelsStatus).not.toHaveBeenCalled();
    expect(snapshotResult).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: {
          channelOrder: [],
          channels: {},
          channelAccounts: {},
          channelDefaultAccountId: {},
        },
        ready: false,
        refreshing: false,
        updatedAt: null,
        error: null,
      },
    });
  });

  it('snapshot 在 Gateway ready 后同步读取 channels.status 并返回实时快照', async () => {
    const deps = createDeps();
    deps.openclawBridge.channelsStatus.mockResolvedValueOnce({
      channels: { feishu: { configured: true } },
      channelAccounts: { feishu: [{ accountId: 'default', running: true, connected: true }] },
      channelDefaultAccountId: { feishu: 'default' },
    });
    deps.listConfiguredChannels.mockResolvedValue(['feishu']);

    const snapshotResult = await dispatchRuntimeRouteDefinition(channelRoutes,
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps.routeDeps,
    );

    expect(deps.submitRefreshSnapshot).not.toHaveBeenCalled();
    expect(deps.openclawBridge.channelsStatus).toHaveBeenCalledWith(false);
    expect(snapshotResult).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: {
          channelOrder: ['feishu'],
          channels: { feishu: { configured: true } },
          channelAccounts: { feishu: [{ accountId: 'default', running: true, connected: true }] },
          channelDefaultAccountId: { feishu: 'default' },
        },
        ready: true,
        refreshing: false,
        updatedAt: 1234,
        error: null,
      },
    });
  });

  it('snapshot 同步刷新失败时保留上一次成功快照并返回错误', async () => {
    const deps = createDeps();
    deps.listConfiguredChannels.mockResolvedValue(['feishu']);
    deps.openclawBridge.channelsStatus
      .mockResolvedValueOnce({
        channels: { feishu: { configured: true } },
        channelAccounts: { feishu: [{ accountId: 'default', running: true, connected: true }] },
        channelDefaultAccountId: { feishu: 'default' },
      })
      .mockRejectedValueOnce(new Error('Gateway RPC timeout: channels.status'));

    await deps.routeDeps.channelService.snapshot();
    const snapshotResult = await dispatchRuntimeRouteDefinition(channelRoutes,
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps.routeDeps,
    );

    expect(snapshotResult).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: {
          channelOrder: ['feishu'],
          channels: { feishu: { configured: true } },
          channelAccounts: { feishu: [{ accountId: 'default', running: true, connected: true }] },
          channelDefaultAccountId: { feishu: 'default' },
        },
        ready: true,
        refreshing: false,
        updatedAt: 1234,
        error: 'Gateway RPC timeout: channels.status',
      },
    });
  });

  it('snapshot 首次同步刷新失败时仍返回已配置渠道快照和错误', async () => {
    const deps = createDeps();
    deps.listConfiguredChannels.mockResolvedValue(['feishu']);
    deps.openclawBridge.channelsStatus.mockRejectedValueOnce(new Error('Gateway RPC timeout: channels.status'));

    const snapshotResult = await dispatchRuntimeRouteDefinition(channelRoutes,
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps.routeDeps,
    );

    expect(snapshotResult).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: {
          channelOrder: ['feishu'],
          channels: { feishu: { configured: true } },
          channelAccounts: { feishu: [] },
          channelDefaultAccountId: {},
        },
        ready: true,
        refreshing: false,
        updatedAt: null,
        error: 'Gateway RPC timeout: channels.status',
      },
    });
  });

  it('connect/disconnect/request-qr capability 统一走 openclawBridge 并刷新快照', async () => {
    const deps = createDeps();

    const connectResult = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.connect',
      { channelType: 'wecom', accountId: 'main' },
    );
    const disconnectResult = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.disconnect',
      { channelType: 'wecom', accountId: 'main' },
    );
    const qrResult = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.requestQr',
      { channelType: 'whatsapp' },
    );

    expect(deps.openclawBridge.channelsStatus).toHaveBeenCalledTimes(3);
    expect(deps.openclawBridge.channelsConnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsDisconnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsRequestQr).toHaveBeenCalledWith('whatsapp');
    expect(connectResult).toEqual({ status: 200, data: { success: true } });
    expect(disconnectResult).toEqual({ status: 200, data: { success: true } });
    expect(qrResult).toEqual({ status: 200, data: { success: true, qrCode: 'qr-code', sessionId: 'session-1' } });
  });

  it('直接提交型渠道激活 capability 只提交后台任务', async () => {
    const deps = createDeps();

    const result = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.activate',
      { channelType: 'wecom', config: { botId: 'bot-1', secret: 'secret-1' } },
    );

    expect(deps.submitActivateDirectChannel).toHaveBeenCalledWith({
      channelType: 'wecom',
      config: { botId: 'bot-1', secret: 'secret-1' },
    });
    expect(deps.saveChannelConfig).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).not.toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-activate',
          type: 'channels.activateDirect',
          status: 'queued',
          queuedAt: 1,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });

  it('直接提交型渠道任务执行时即使配置不变也会保存配置并触发 gateway_restart', async () => {
    const deps = createDeps();

    const result = await deps.routeDeps.channelService.activateDirect({
      channelType: 'wecom',
      config: { botId: 'bot-1', secret: 'secret-1' },
    });

    expect(deps.saveChannelConfig).toHaveBeenCalledOnce();
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({ success: true });
  });

  it('登录会话型渠道激活 capability 不会立即写配置或重启 gateway', async () => {
    const deps = createDeps();

    const result = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.activate',
      { channelType: 'openclaw-weixin', accountId: 'wx-main', config: { routeTag: 'prod' } },
    );

    expect(deps.saveChannelConfig).not.toHaveBeenCalled();
    expect(deps.startLoginSession).toHaveBeenCalledWith({
      channelType: 'openclaw-weixin',
      accountId: 'wx-main',
      config: { routeTag: 'prod' },
    });
    expect(deps.prepareChannelPlugin).toHaveBeenCalledWith('openclaw-weixin');
    expect(deps.prepareChannelPlugin.mock.invocationCallOrder[0]).toBeLessThan(
      deps.startLoginSession.mock.invocationCallOrder[0],
    );
    expect(deps.requestParentShellAction).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 200, data: { success: true, queued: true, sessionKey: 'wx-main' } });
  });

  it('登录会话型渠道取消 capability 走统一 session cancel', async () => {
    const deps = createDeps();

    const result = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.cancelSession',
      { channelType: 'whatsapp' },
    );

    expect(deps.cancelLoginSession).toHaveBeenCalledWith('whatsapp');
    expect(deps.requestParentShellAction).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('删除渠道配置 capability 只提交后台任务', async () => {
    const deps = createDeps();

    const result = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.deleteConfig',
      { channelType: 'wecom' },
    );

    expect(deps.submitDeleteChannelConfig).toHaveBeenCalledWith({ channelType: 'wecom' });
    expect(deps.deleteChannelConfig).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).not.toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-delete',
          type: 'channels.deleteConfig',
          status: 'queued',
          queuedAt: 3,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });

  it('深度 probe 渠道 capability 只提交后台任务，不会同步访问 gateway', async () => {
    const deps = createDeps();

    const result = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.probe',
    );

    expect(deps.submitProbeSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.openclawBridge.channelsStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-probe',
          type: 'channels.probeSnapshot',
          status: 'queued',
          queuedAt: 2,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });

  it('渠道配对列表和审批走 runtime-host pairing 服务', async () => {
    const deps = createDeps();

    const listResult = await dispatchRuntimeRouteDefinition(channelRoutes,
      'GET',
      '/api/channels/pairing/feishu',
      new URL('http://127.0.0.1/api/channels/pairing/feishu?accountId=default'),
      undefined,
      deps.routeDeps,
    );
    const approveResult = await dispatchChannelIntegrationCapability(
      deps.routeDeps.channelService,
      'channels.approvePairing',
      { channelType: 'feishu', code: ' RTHZA8EP ', accountId: 'default' },
    );

    expect(deps.listPairingRequests).toHaveBeenCalledWith({
      channelType: 'feishu',
      accountId: 'default',
    });
    expect(deps.approvePairingRequest).toHaveBeenCalledWith({
      channelType: 'feishu',
      code: 'RTHZA8EP',
      accountId: 'default',
    });
    expect(listResult).toEqual({
      status: 200,
      data: {
        success: true,
        requests: [{
          id: 'ou_user_1',
          code: 'RTHZA8EP',
          createdAt: '2026-05-18T00:00:00.000Z',
          lastSeenAt: '2026-05-18T00:01:00.000Z',
          meta: { name: 'Alice' },
        }],
      },
    });
    expect(approveResult).toEqual({
      status: 200,
      data: {
        success: true,
        approved: {
          id: 'ou_user_1',
          entry: {
            id: 'ou_user_1',
            code: 'RTHZA8EP',
            createdAt: '2026-05-18T00:00:00.000Z',
            lastSeenAt: '2026-05-18T00:01:00.000Z',
          },
        },
      },
    });
  });
});
