import { describe, expect, it, vi } from 'vitest';
import { handleRuntimeHostRoute } from '../../runtime-host/api/routes/runtime-host-routes';

describe('runtime-host process runtime-host routes', () => {
  it('GET /api/runtime-host/provider-env-map 返回 provider env 映射', async () => {
    const result = await handleRuntimeHostRoute(
      'GET',
      '/api/runtime-host/provider-env-map',
      undefined,
      {
        createHealthPayload: () => ({ success: true }),
        buildTransportStatsSnapshot: () => ({ success: true }),
        syncGatewayConfigLocal: vi.fn(async () => ({ configuredChannels: [] })),
        buildProviderEnvMap: () => ({
          keyableProviderTypes: ['openai', 'groq'],
          envVarByProviderType: {
            openai: 'OPENAI_API_KEY',
            groq: 'GROQ_API_KEY',
          },
        }),
        syncProviderAuthBootstrapLocal: vi.fn(async () => ({ syncedApiKeyCount: 0 })),
        collectDiagnosticsBundleLocal: vi.fn(async () => ({ zipPath: 'mock.zip' })),
      },
    );

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        keyableProviderTypes: ['openai', 'groq'],
        envVarByProviderType: {
          openai: 'OPENAI_API_KEY',
          groq: 'GROQ_API_KEY',
        },
      },
    });
  });

  it('POST /api/runtime-host/sync-gateway-config 会调用本地同步能力', async () => {
    const syncGatewayConfigLocal = vi.fn(async () => ({
      configuredChannels: ['openclaw-weixin'],
    }));

    const result = await handleRuntimeHostRoute(
      'POST',
      '/api/runtime-host/sync-gateway-config',
      {
        gatewayToken: 'token-1',
        proxyEnabled: true,
        proxyServer: 'http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      },
      {
        createHealthPayload: () => ({ success: true }),
        buildTransportStatsSnapshot: () => ({ success: true }),
        syncGatewayConfigLocal,
        buildProviderEnvMap: () => ({
          keyableProviderTypes: [],
          envVarByProviderType: {},
        }),
        syncProviderAuthBootstrapLocal: vi.fn(async () => ({ syncedApiKeyCount: 0 })),
        collectDiagnosticsBundleLocal: vi.fn(async () => ({ zipPath: 'mock.zip' })),
      },
    );

    expect(syncGatewayConfigLocal).toHaveBeenCalledWith({
      gatewayToken: 'token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        configuredChannels: ['openclaw-weixin'],
      },
    });
  });

  it('POST /api/runtime-host/sync-provider-auth-bootstrap 返回同步统计', async () => {
    const syncProviderAuthBootstrapLocal = vi.fn(async () => ({
      syncedApiKeyCount: 3,
      defaultProviderId: 'openai-main',
    }));

    const result = await handleRuntimeHostRoute(
      'POST',
      '/api/runtime-host/sync-provider-auth-bootstrap',
      null,
      {
        createHealthPayload: () => ({ success: true }),
        buildTransportStatsSnapshot: () => ({ success: true }),
        syncGatewayConfigLocal: vi.fn(async () => ({ configuredChannels: [] })),
        buildProviderEnvMap: () => ({
          keyableProviderTypes: [],
          envVarByProviderType: {},
        }),
        syncProviderAuthBootstrapLocal,
        collectDiagnosticsBundleLocal: vi.fn(async () => ({ zipPath: 'mock.zip' })),
      },
    );

    expect(syncProviderAuthBootstrapLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        syncedApiKeyCount: 3,
        defaultProviderId: 'openai-main',
      },
    });
  });
});
