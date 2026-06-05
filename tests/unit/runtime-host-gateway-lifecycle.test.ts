import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostBootstrapService } from '../../runtime-host/application/runtime-host/bootstrap';

function createBootstrapService() {
  const service = new RuntimeHostBootstrapService({
    gatewayPrelaunchWorkflow: {
      getHostBootstrapSettings: vi.fn(),
      buildGatewayLaunchPlan: vi.fn(),
      executeGatewayPrelaunch: vi.fn(),
      executeProviderAuthBootstrap: vi.fn(),
      executeWorkspaceTemplateMigration: vi.fn(),
    },
    jobs: {
      submitGatewayPrelaunch: vi.fn(),
      submitProviderAuthBootstrap: vi.fn(),
      submitWorkspaceTemplateMigration: vi.fn(),
    },
  });

  return { service };
}

describe('runtime-host gateway lifecycle', () => {
  it('Gateway running 事件不再提交安全策略同步 job', () => {
    const { service } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'running', port: 18789 });

    expect(job).toBeNull();
  });

  it('非 running 生命周期事件不触发业务 job', () => {
    const { service } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'stopped' });

    expect(job).toBeNull();
  });
});
