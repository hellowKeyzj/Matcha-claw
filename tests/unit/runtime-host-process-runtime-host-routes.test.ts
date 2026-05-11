import { describe, expect, it, vi } from 'vitest';
import { runtimeHostRoutes } from '../../runtime-host/api/routes/runtime-host-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createService() {
  return {
    health: vi.fn(() => ({ success: true })),
    transportStats: vi.fn(() => ({ success: true })),
    prepareGatewayLaunch: vi.fn(async () => ({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-prelaunch-1',
          type: 'runtimeHost.gatewayPrelaunch',
        },
      },
    })),
    providerEnvMap: vi.fn(() => ({
      success: true,
      keyableProviderTypes: ['openai', 'groq'],
      envVarByProviderType: {
        openai: 'OPENAI_API_KEY',
        groq: 'GROQ_API_KEY',
      },
    })),
    syncProviderAuthBootstrap: vi.fn(() => ({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-provider-auth-1',
          type: 'runtimeHost.providerAuthBootstrap',
        },
      },
    })),
    runtimeJobs: vi.fn(() => ({
      success: true,
      queue: { stopped: false },
      registeredTypes: ['plugins.refreshCatalog'],
      jobs: [{ id: 'job-1', type: 'plugins.refreshCatalog' }],
    })),
    runtimeJob: vi.fn(() => ({
      status: 200,
      data: {
        success: true,
        job: { id: 'job-1' },
      },
    })),
    collectDiagnostics: vi.fn(async () => ({
      status: 202,
      data: {
        success: true,
        job: { id: 'job-1', type: 'diagnostics.collect' },
      },
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

  it('POST /api/runtime-host/prepare-gateway-launch 透传 payload 给服务', async () => {
    const service = createService();
    const payload = {
      gatewayToken: 'token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    };

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'POST',
      '/api/runtime-host/prepare-gateway-launch',
      new URL('http://127.0.0.1/api/runtime-host/prepare-gateway-launch'),
      payload,
      service,
    );

    expect(service.prepareGatewayLaunch).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-prelaunch-1',
          type: 'runtimeHost.gatewayPrelaunch',
        },
      },
    });
  });

  it('POST /api/runtime-host/sync-provider-auth-bootstrap 提交已注入服务的任务', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'POST',
      '/api/runtime-host/sync-provider-auth-bootstrap',
      new URL('http://127.0.0.1/api/runtime-host/sync-provider-auth-bootstrap'),
      null,
      service,
    );

    expect(service.syncProviderAuthBootstrap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-provider-auth-1',
          type: 'runtimeHost.providerAuthBootstrap',
        },
      },
    });
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

  it('POST /api/runtime-host/jobs/get 读取单个任务状态', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'POST',
      '/api/runtime-host/jobs/get',
      new URL('http://127.0.0.1/api/runtime-host/jobs/get'),
      { jobId: 'job-1' },
      service,
    );

    expect(service.runtimeJob).toHaveBeenCalledWith({ jobId: 'job-1' });
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        job: { id: 'job-1' },
      },
    });
  });

  it('POST /api/diagnostics/collect 提交后台任务，不在请求链路中打包', async () => {
    const service = createService();

    const result = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'POST',
      '/api/diagnostics/collect',
      new URL('http://127.0.0.1/api/diagnostics/collect'),
      {
        userDataDir: 'userdata',
        openclawConfigDir: 'openclaw',
        appInfo: {
          name: 'MatchaClaw',
          version: '0.0.0',
          isPackaged: false,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
        },
      },
      service,
    );

    expect(service.collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: { id: 'job-1', type: 'diagnostics.collect' },
      },
    });
  });
});
