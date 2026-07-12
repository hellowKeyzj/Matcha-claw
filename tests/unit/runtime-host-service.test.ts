import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostService } from '../../runtime-host/application/runtime-host/service';
import { DiagnosticsCollectionWorkflow } from '../../runtime-host/application/workflows/diagnostics/diagnostics-collection-workflow';
import { RuntimeHostOperationsWorkflow } from '../../runtime-host/application/workflows/runtime-host/runtime-host-operations-workflow';

function createService() {
  const submitGatewayPrelaunch = vi.fn(() => ({
    success: true,
    job: {
      id: 'job-prelaunch-1',
      type: 'runtimeHost.gatewayPrelaunch',
    },
  }));
  const submitDiagnosticsCollection = vi.fn(() => ({
    success: true,
    job: {
      id: 'job-1',
      type: 'diagnostics.collect',
    },
  }));
  const diagnosticsCollectionWorkflow = new DiagnosticsCollectionWorkflow({
    environment: {
      getRuntimeDataRootDir: () => 'openclaw',
    },
    processInfo: {
      nodeVersion: process.versions.node,
    },
    systemEnvironment: {
      appName: 'MatchaClaw',
      appVersion: '0.0.0',
      isPackaged: false,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
    },
    diagnostics: {
      submitCollect: submitDiagnosticsCollection,
    },
    license: {
      gate: vi.fn(async () => ({
        status: 200,
        data: {
          state: 'granted',
          reason: 'test',
        },
      })),
    },
    parentShell: {
      request: vi.fn(async () => ({
        version: 1,
        success: true,
        status: 200,
        data: {
          success: true,
          snapshot: {
            userDataDir: 'userdata',
            appInfo: {
              name: 'MatchaClaw',
              version: '0.0.0',
              isPackaged: false,
              platform: process.platform,
              arch: process.arch,
              node: process.versions.node,
            },
          },
        },
      })),
    },
  });
  const operationsWorkflow = new RuntimeHostOperationsWorkflow({
    bootstrap: {
      submitGatewayPrelaunch,
      buildProviderEnvMap: vi.fn(() => ({
        keyableProviderTypes: [],
        envVarByProviderType: {},
      })),
      getHostBootstrapSettings: vi.fn(async () => ({
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '',
        browserMode: 'off',
        sessionIdleMinutes: 30,
      })),
      buildGatewayLaunchPlan: vi.fn(async () => ({
        launchId: 'launch-1',
        gatewayToken: 'token-1',
        providerEnv: {},
        settings: {
          proxyEnabled: false,
          proxyServer: '',
          proxyBypassRules: '',
          browserMode: 'off',
          sessionIdleMinutes: 30,
        },
      })),
      onGatewayLifecycle: vi.fn(() => null),
    },
    diagnosticsCollectionWorkflow,
    jobs: {
      list: vi.fn(() => ({ success: true, queue: { pending: 0, running: 0 }, registeredTypes: [], jobs: [] })),
      get: vi.fn(() => ({ success: true, job: null })),
    },
  });
  const service = new RuntimeHostService({
    runtimeState: {
      health: vi.fn(() => ({ success: true })),
      transportStats: vi.fn(() => ({ success: true })),
      runtimeState: vi.fn(() => ({ lifecycle: 'running', plugins: [] })),
    },
    operationsWorkflow,
  });
  return {
    service,
    submitGatewayPrelaunch,
    submitDiagnosticsCollection,
  };
}

describe('runtime host service', () => {
  it('prepareGatewayLaunch validates payload then submits a gateway prelaunch job', async () => {
    const { service, submitGatewayPrelaunch } = createService();

    const response = await service.prepareGatewayLaunch({
      gatewayToken: 'token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(response).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-prelaunch-1',
          type: 'runtimeHost.gatewayPrelaunch',
        },
      },
    });
    expect(submitGatewayPrelaunch).toHaveBeenCalledWith({
      gatewayToken: 'token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });
  });

  it('collectDiagnostics validates payload then submits a background diagnostics job', async () => {
    const { service, submitDiagnosticsCollection } = createService();

    const response = await service.collectDiagnostics({
      userDataDir: 'userdata',
      runtimeDataRootDir: 'runtime-data',
      appInfo: {
        name: 'MatchaClaw',
        version: '0.0.0',
        isPackaged: false,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
      },
    });

    expect(response).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-1',
          type: 'diagnostics.collect',
        },
      },
    });
    expect(submitDiagnosticsCollection).toHaveBeenCalledTimes(1);
  });
});
