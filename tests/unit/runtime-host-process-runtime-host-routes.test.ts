import { describe, expect, it, vi } from 'vitest';
import { runtimeHostRoutes } from '../../runtime-host/api/routes/runtime-host-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createService() {
  return {
    health: vi.fn(() => ({ success: true })),
    transportStats: vi.fn(() => ({ success: true })),
    providerEnvMap: vi.fn(() => ({
      success: true,
      keyableProviderTypes: ['openai', 'groq'],
      envVarByProviderType: {
        openai: 'OPENAI_API_KEY',
        groq: 'GROQ_API_KEY',
      },
    })),
    hostBootstrapSettings: vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        settings: {
          gatewayToken: 'gateway-token-secret',
          launchAtStartup: true,
          gatewayAutoStart: true,
        },
      },
    })),
    gatewayLaunchPlan: vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        plan: {
          gatewayToken: 'gateway-token-secret',
          providerEnv: { OPENAI_API_KEY: 'sk-secret' },
          loadedProviderKeyCount: 1,
          skipChannels: false,
          channelStartupSummary: 'enabled(feishu)',
        },
      },
    })),
    runtimeJobs: vi.fn(() => ({
      success: true,
      queue: { stopped: false },
      registeredTypes: ['plugins.refreshCatalog'],
      jobs: [{ id: 'job-1', type: 'plugins.refreshCatalog' }],
    })),
  };
}

describe('runtime-host process runtime-host routes', () => {
  it('GET /api/runtime-host/provider-env-map 调用已注入服务', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'GET',
      '/api/runtime-host/provider-env-map',
      new URL('http://127.0.0.1/api/runtime-host/provider-env-map'),
      undefined,
      service,
    );

    expect(service.providerEnvMap).toHaveBeenCalledTimes(1);
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

  it('GET /api/runtime-host/host-bootstrap-settings 不返回 gatewayToken', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes,
      'GET',
      '/api/runtime-host/host-bootstrap-settings',
      new URL('http://127.0.0.1/api/runtime-host/host-bootstrap-settings'),
      undefined,
      service,
    );

    expect(service.hostBootstrapSettings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        settings: {
          launchAtStartup: true,
          gatewayAutoStart: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('gateway-token-secret');
  });

  it('GET /api/runtime-host/gateway-launch-plan 不返回 gatewayToken 或 providerEnv secret values', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes,
      'GET',
      '/api/runtime-host/gateway-launch-plan',
      new URL('http://127.0.0.1/api/runtime-host/gateway-launch-plan'),
      undefined,
      service,
    );

    expect(service.gatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        plan: {
          loadedProviderKeyCount: 1,
          skipChannels: false,
          channelStartupSummary: 'enabled(feishu)',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('gateway-token-secret');
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('GET /api/runtime-host/jobs 按查询参数读取任务状态', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'GET',
      '/api/runtime-host/jobs',
      new URL('http://127.0.0.1/api/runtime-host/jobs?type=plugins.refreshCatalog'),
      undefined,
      service,
    );

    expect(service.runtimeJobs).toHaveBeenCalledWith({
      type: 'plugins.refreshCatalog',
    });
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        queue: { stopped: false },
        registeredTypes: ['plugins.refreshCatalog'],
        jobs: [{ id: 'job-1', type: 'plugins.refreshCatalog' }],
      },
    });
  });

  it('POST /api/runtime-host/jobs/get 不再注册 legacy 任务详情路由', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes,
      'POST',
      '/api/runtime-host/jobs/get',
      new URL('http://127.0.0.1/api/runtime-host/jobs/get'),
      { jobId: 'job-1' },
      service,
    );

    expect(runtimeHostRoutes.some((route) => route.method === 'POST' && route.path === '/api/runtime-host/jobs/get')).toBe(false);
    expect(result).toBeNull();
  });

});
