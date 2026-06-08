import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/runtime/runtime-host-capability';
import { channelRoutes } from '../../runtime-host/api/routes/channel-routes';
import { fileRoutes } from '../../runtime-host/api/routes/file-routes';
import { gatewayRoutes } from '../../runtime-host/api/routes/gateway-routes';
import { licenseRoutes } from '../../runtime-host/api/routes/license-routes';
import { providerModelsRoutes } from '../../runtime-host/api/routes/provider-models-routes';
import { providerRoutes } from '../../runtime-host/api/routes/provider-routes';
import { runtimeHostRoutes } from '../../runtime-host/api/routes/runtime-host-routes';
import { runtimeTopologyRoutes } from '../../runtime-host/api/routes/runtime-topology-routes';
import { sessionRoutes } from '../../runtime-host/api/routes/session-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function expectBadRequest(response: unknown) {
  expect(response).toMatchObject({
    status: 400,
    data: { success: false },
  });
}

function capabilityContext(input: Record<string, unknown>, target: Record<string, unknown>) {
  return {
    capabilityId: 'runtime.host',
    operationId: 'runtimeHost.jobGet',
    scope: { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'openclaw-local' } },
    target,
    input,
    domainInput: input,
  };
}

describe('runtime-host legacy route boundary', () => {
  it('rejects high-risk session legacy mutations without dispatching services', async () => {
    const service = {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      archiveSession: vi.fn(),
      unarchiveSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      listSessions: vi.fn(),
      loadSession: vi.fn(),
      resumeSession: vi.fn(),
      patchSession: vi.fn(),
      renameSession: vi.fn(),
      switchSession: vi.fn(),
      getSessionStateSnapshot: vi.fn(),
      getSessionWindow: vi.fn(),
      abortSession: vi.fn(),
      listPendingApprovals: vi.fn(),
      resolveApproval: vi.fn(),
      promptSession: vi.fn(),
    };

    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', '/api/sessions/prompt', { sessionId: 's1' }, service))
      .resolves.toMatchObject({ status: 400 });
    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', '/api/sessions/approval/resolve', { approvalId: 'a1' }, service))
      .resolves.toMatchObject({ status: 400 });

    expect(service.promptSession).not.toHaveBeenCalled();
    expect(service.resolveApproval).not.toHaveBeenCalled();
  });

  it('keeps only explicit read-only session legacy routes dispatchable with endpoint identity DTOs and sanitized output', async () => {
    const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'openclaw-local' };
    const service = {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      archiveSession: vi.fn(),
      unarchiveSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      listSessions: vi.fn(async () => ({ sessions: [{ id: 's1', endpoint, token: 'secret-token' }] })),
      loadSession: vi.fn(),
      resumeSession: vi.fn(),
      patchSession: vi.fn(),
      renameSession: vi.fn(),
      switchSession: vi.fn(),
      getSessionStateSnapshot: vi.fn(),
      getSessionWindow: vi.fn(),
      abortSession: vi.fn(),
      listPendingApprovals: vi.fn(),
      resolveApproval: vi.fn(),
      promptSession: vi.fn(),
    };

    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', '/api/sessions/list', { endpoint }, service))
      .resolves.toEqual({ status: 200, data: { sessions: [{ id: 's1', endpoint }] } });
    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', '/api/sessions/list', {}, service))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'RuntimeEndpointRef is required' } });
    expect(service.listSessions).toHaveBeenCalledTimes(1);
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it('rejects all legacy file routes without dispatching file services', async () => {
    const fileService = {
      readText: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      stagePaths: vi.fn(),
      stageBuffer: vi.fn(),
      thumbnail: vi.fn(),
      thumbnails: vi.fn(),
    };

    for (const path of [
      '/api/files/read-text',
      '/api/files/read-binary',
      '/api/files/stat',
      '/api/files/list-dir',
      '/api/files/thumbnails',
      '/api/files/write-text',
      '/api/files/stage-paths',
      '/api/files/stage-buffer',
      '/api/files/thumbnail',
    ]) {
      expectBadRequest(await dispatchRuntimeRouteDefinition(fileRoutes, 'POST', path, { path: 'secret.txt' }, { fileService }));
    }

    expect(fileService.readText).not.toHaveBeenCalled();
    expect(fileService.readBinary).not.toHaveBeenCalled();
    expect(fileService.stat).not.toHaveBeenCalled();
    expect(fileService.listDir).not.toHaveBeenCalled();
    expect(fileService.writeText).not.toHaveBeenCalled();
    expect(fileService.stagePaths).not.toHaveBeenCalled();
    expect(fileService.stageBuffer).not.toHaveBeenCalled();
    expect(fileService.thumbnail).not.toHaveBeenCalled();
    expect(fileService.thumbnails).not.toHaveBeenCalled();
  });

  it('rejects provider secret routes without exposing full keys or validation dispatch', async () => {
    const providerAccountsService = {
      list: vi.fn(),
      validate: vi.fn(),
      getApiKey: vi.fn(),
      hasApiKey: vi.fn(),
      get: vi.fn(),
    };

    expectBadRequest(await dispatchRuntimeRouteDefinition(providerRoutes, 'GET', '/api/provider-accounts/account-1/api-key', undefined, { providerAccountsService }));
    expectBadRequest(await dispatchRuntimeRouteDefinition(providerRoutes, 'POST', '/api/provider-accounts/validate', { apiKey: 'sk-full' }, { providerAccountsService }));
    expectBadRequest(await dispatchRuntimeRouteDefinition(providerRoutes, 'GET', '/api/provider-accounts/account-1', undefined, { providerAccountsService }));

    expect(providerAccountsService.getApiKey).not.toHaveBeenCalled();
    expect(providerAccountsService.validate).not.toHaveBeenCalled();
    expect(providerAccountsService.get).not.toHaveBeenCalled();
  });

  it('rejects legacy provider model detail route without dispatching model services', async () => {
    const providerModelsService = {
      readAll: vi.fn(),
      readSelectable: vi.fn(),
      read: vi.fn(),
    };

    expectBadRequest(await dispatchRuntimeRouteDefinition(providerModelsRoutes, 'GET', '/api/provider-models/account-1', undefined, { providerModelsService }));

    expect(providerModelsService.read).not.toHaveBeenCalled();
  });

  it('does not expose legacy runtime job detail route and keeps capability job detail path', async () => {
    const service = {
      health: vi.fn(),
      transportStats: vi.fn(),
      providerEnvMap: vi.fn(),
      hostBootstrapSettings: vi.fn(),
      gatewayLaunchPlan: vi.fn(),
      runtimeJobs: vi.fn(() => ({ jobs: [{ id: 'job-1', output: 'full output', stdout: 'secret stdout', status: 'running' }] })),
    };
    const runtimeHostService = {
      prepareGatewayLaunch: vi.fn(),
      syncProviderAuthBootstrap: vi.fn(),
      gatewayLifecycle: vi.fn(),
      collectDiagnostics: vi.fn(),
      runtimeJob: vi.fn(() => ({ status: 200, data: { success: true, job: { id: 'job-1' } } })),
    };
    const gatewayService = {
      ready: vi.fn(),
      approvePendingControlUiPairingRequests: vi.fn(),
    };

    const snapshot = await dispatchRuntimeRouteDefinition(runtimeHostRoutes, 'GET', '/api/runtime-host/jobs', new URL('http://runtime-host.local/api/runtime-host/jobs'), undefined, service);
    expect(snapshot).toEqual({ status: 200, data: { jobs: [{ id: 'job-1', status: 'running' }] } });
    expect(runtimeHostRoutes.some((route) => route.method === 'POST' && route.path === '/api/runtime-host/jobs/get')).toBe(false);
    await expect(dispatchRuntimeRouteDefinition(runtimeHostRoutes, 'POST', '/api/runtime-host/jobs/get', { id: 'job-1' }, service))
      .resolves.toBeNull();

    const jobGetRoute = createRuntimeHostCapabilityOperationRoutes({ runtimeHostService, gatewayService })
      .find((route) => route.capabilityId === 'runtime.host' && route.operationId === 'runtimeHost.jobGet');
    expect(jobGetRoute).toBeDefined();
    expect(await jobGetRoute!.handle(capabilityContext({ jobId: 'job-1' }, { kind: 'runtime-job', jobId: 'job-1' })))
      .toEqual({ status: 200, data: { success: true, job: { id: 'job-1' } } });
    expect(runtimeHostService.runtimeJob).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('rejects gateway control routes and redacts pairing control state from status', async () => {
    const gatewayService = {
      status: vi.fn(async () => ({
        status: 200,
        data: {
          connected: true,
          controlState: { pending: true },
          pendingControlUiPairingRequests: [{ token: 'pair-token' }],
        },
      })),
      ready: vi.fn(),
      approvePendingControlUiPairingRequests: vi.fn(),
    };

    await expect(dispatchRuntimeRouteDefinition(gatewayRoutes, 'GET', '/api/gateway/status', undefined, { gatewayService }))
      .resolves.toEqual({ status: 200, data: { connected: true } });

    expectBadRequest(await dispatchRuntimeRouteDefinition(gatewayRoutes, 'POST', '/api/gateway/ready', {}, { gatewayService }));
    expectBadRequest(await dispatchRuntimeRouteDefinition(gatewayRoutes, 'POST', '/api/gateway/control-ui/auto-approve', {}, { gatewayService }));
    expect(gatewayService.ready).not.toHaveBeenCalled();
    expect(gatewayService.approvePendingControlUiPairingRequests).not.toHaveBeenCalled();
  });

  it('rejects runtime connector lifecycle routes without dispatching topology services', async () => {
    const service = {
      snapshotRuntimeTopology: vi.fn(),
      connectRuntimeConnectorEndpoint: vi.fn(),
      disconnectRuntimeConnectorEndpoint: vi.fn(),
    };

    expectBadRequest(await dispatchRuntimeRouteDefinition(runtimeTopologyRoutes, 'POST', '/api/runtime-connectors/connect', { connectorId: 'c1' }, service));
    expectBadRequest(await dispatchRuntimeRouteDefinition(runtimeTopologyRoutes, 'POST', '/api/runtime-connectors/disconnect', { connectorId: 'c1' }, service));
    expect(service.connectRuntimeConnectorEndpoint).not.toHaveBeenCalled();
    expect(service.disconnectRuntimeConnectorEndpoint).not.toHaveBeenCalled();
  });

  it('redacts secrets from read-only license and channel direct routes', async () => {
    const licenseService = {
      gate: vi.fn(async () => ({ status: 200, data: { lastValidation: { valid: true, normalizedKey: 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD', code: 'valid' } } })),
      storedKey: vi.fn(async () => ({ status: 200, data: { key: 'MATCHACLAW-FULL-KEY', hasStoredKey: true } })),
    };
    const channelService = {
      snapshot: vi.fn(),
      validateConfig: vi.fn(),
      validateCredentials: vi.fn(),
      getConfigValues: vi.fn(async () => ({ channelType: 'wecom', secret: 'full-secret', accessToken: 'token', enabled: true })),
      listPairingRequests: vi.fn(async () => ({ status: 200, data: { requests: [{ id: 'r1', token: 'pair-token', status: 'pending' }] } })),
    };

    await expect(dispatchRuntimeRouteDefinition(licenseRoutes, 'GET', '/api/license/gate', undefined, { licenseService }))
      .resolves.toEqual({ status: 200, data: { lastValidation: { valid: true, code: 'valid' } } });
    await expect(dispatchRuntimeRouteDefinition(licenseRoutes, 'GET', '/api/license/stored-key', undefined, { licenseService }))
      .resolves.toEqual({ status: 200, data: { hasStoredKey: true } });
    expectBadRequest(await dispatchRuntimeRouteDefinition(channelRoutes, 'GET', '/api/channels/config/wecom', undefined, { channelService }));
    await expect(dispatchRuntimeRouteDefinition(channelRoutes, 'GET', '/api/channels/pairing/wecom', undefined, { channelService }))
      .resolves.toEqual({ status: 200, data: { requests: [{ id: 'r1', status: 'pending' }] } });
    expect(channelService.getConfigValues).not.toHaveBeenCalled();
  });
});
