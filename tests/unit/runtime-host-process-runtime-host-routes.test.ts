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

});
