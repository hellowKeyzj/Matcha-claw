import { describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '../../runtime-host/api/routes/channel-routes';
import { clawHubRoutes } from '../../runtime-host/api/routes/clawhub-routes';
import { gatewayRoutes } from '../../runtime-host/api/routes/gateway-routes';
import { licenseRoutes } from '../../runtime-host/api/routes/license-routes';
import { openClawRoutes } from '../../runtime-host/api/routes/openclaw-routes';
import { platformRoutes } from '../../runtime-host/api/routes/platform-routes';
import { providerRoutes } from '../../runtime-host/api/routes/provider-routes';
import { securityRoutes } from '../../runtime-host/api/routes/security-routes';
import { settingsRoutes } from '../../runtime-host/api/routes/settings-routes';
import { skillsRoutes } from '../../runtime-host/api/routes/skills-routes';
import { subagentRoutes } from '../../runtime-host/api/routes/subagent-routes';
import { workbenchRoutes } from '../../runtime-host/api/routes/workbench-routes';
import { runtimeHostRoutes } from '../../runtime-host/api/routes/runtime-host-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

describe('runtime-host service-injected routes', () => {
  it('routes channel requests through the injected channel service', async () => {
    const channelService = {
      snapshot: vi.fn(async () => ({ success: true, snapshot: [] })),
      probe: vi.fn(),
      validateConfig: vi.fn(),
      validateCredentials: vi.fn(),
      activate: vi.fn(),
      cancelSession: vi.fn(),
      setEnabled: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      requestQr: vi.fn(),
      getConfigValues: vi.fn(),
      deleteConfig: vi.fn(),
    };

    const response = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      { channelService },
    );

    expect(response).toEqual({
      status: 200,
      data: { success: true, snapshot: [] },
    });
    expect(channelService.snapshot).toHaveBeenCalledTimes(1);
  });

  it('routes settings requests through the injected settings service', async () => {
    const settingsService = {
      getAll: vi.fn(async () => ({ theme: 'dark' })),
      patch: vi.fn(),
      reset: vi.fn(),
      getValue: vi.fn(),
      setValue: vi.fn(),
    };

    const response = await dispatchRuntimeRouteDefinition(settingsRoutes, 
      'GET',
      '/api/settings',
      undefined,
      { settingsService },
    );

    expect(response).toEqual({
      status: 200,
      data: { theme: 'dark' },
    });
    expect(settingsService.getAll).toHaveBeenCalledTimes(1);
  });

  it('routes provider account requests through the injected provider service', async () => {
    const providerAccountsService = {
      list: vi.fn(async () => ({ accounts: [] })),
      create: vi.fn(),
      setDefault: vi.fn(),
      validate: vi.fn(),
      startOAuth: vi.fn(),
      cancelOAuth: vi.fn(),
      submitOAuth: vi.fn(),
      completeBrowser: vi.fn(),
      completeDevice: vi.fn(),
      getApiKey: vi.fn(),
      hasApiKey: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const response = await dispatchRuntimeRouteDefinition(providerRoutes, 
      'GET',
      '/api/provider-accounts',
      new URL('http://127.0.0.1/api/provider-accounts'),
      undefined,
      { providerAccountsService },
    );

    expect(response).toEqual({
      status: 200,
      data: { accounts: [] },
    });
    expect(providerAccountsService.list).toHaveBeenCalledTimes(1);
  });

  it('routes remaining API modules through injected services', async () => {
    await expect(dispatchRuntimeRouteDefinition(workbenchRoutes, 'GET', '/api/workbench/bootstrap', undefined, {
      workbenchService: { bootstrap: vi.fn(() => ({ ready: true })) },
    })).resolves.toEqual({ status: 200, data: { ready: true } });

    await expect(dispatchRuntimeRouteDefinition(openClawRoutes, 'GET', '/api/openclaw/status', undefined, {
      openClawService: {
        status: vi.fn(() => ({ ready: true })),
        ready: vi.fn(),
        dir: vi.fn(),
        configDir: vi.fn(),
        subagentTemplates: vi.fn(),
        subagentTemplate: vi.fn(),
        workspaceDir: vi.fn(),
        taskWorkspaceDirs: vi.fn(),
        skillsDir: vi.fn(),
        cliCommand: vi.fn(),
      },
    })).resolves.toEqual({ status: 200, data: { ready: true } });

    const gatewayService = {
      rpc: vi.fn(),
      status: vi.fn(async () => ({ status: 200, data: { connected: true } })),
      ready: vi.fn(),
      sendMedia: vi.fn(),
      agentWait: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(gatewayRoutes, 'GET', '/api/gateway/status', undefined, { gatewayService }))
      .resolves.toEqual({ status: 200, data: { connected: true } });

    const licenseService = {
      gate: vi.fn(async () => ({ status: 200, data: { allowed: true } })),
      storedKey: vi.fn(),
      validate: vi.fn(),
      revalidate: vi.fn(),
      clear: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(licenseRoutes, 'GET', '/api/license/gate', undefined, { licenseService }))
      .resolves.toEqual({ status: 200, data: { allowed: true } });

    const skillsService = {
      status: vi.fn(() => ({ skills: [] })),
      updateConfig: vi.fn(),
      updateState: vi.fn(),
      updateBatchState: vi.fn(),
      effective: vi.fn(),
      readmePreview: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(skillsRoutes, 'GET', '/api/skills/status', undefined, { skillsService }))
      .resolves.toEqual({ status: 200, data: { skills: [] } });

    const subagentService = {
      listAgents: vi.fn(async () => ({ status: 200, data: { agents: [] } })),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      getAgentFile: vi.fn(),
      setAgentFile: vi.fn(),
      listAgentFiles: vi.fn(),
      waitAgent: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/list', {}, { subagentService }))
      .resolves.toEqual({ status: 200, data: { agents: [] } });

    const securityService = {
      readPolicy: vi.fn(() => ({ policy: true })),
      writePolicy: vi.fn(async () => ({ status: 202, data: { success: true } })),
      listRuleCatalog: vi.fn(),
      queryAudit: vi.fn(),
      syncCurrentPolicyToGatewayIfRunning: vi.fn(() => ({ status: 202, data: { success: true } })),
      runQuickAudit: vi.fn(),
      runEmergencyResponse: vi.fn(),
      checkIntegrity: vi.fn(),
      rebaselineIntegrity: vi.fn(),
      scanSkillsFromPayload: vi.fn(),
      checkAdvisoriesFromUrl: vi.fn(),
      previewRemediation: vi.fn(),
      applyRemediationFromPayload: vi.fn(),
      rollbackRemediationFromPayload: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(securityRoutes, 
      'GET',
      '/api/security',
      new URL('http://127.0.0.1/api/security'),
      undefined,
      { securityService },
    )).resolves.toEqual({ status: 200, data: { policy: true } });

    const platformService = {
      runtimeHealth: vi.fn(async () => ({ ok: true })),
      startRun: vi.fn(),
      abortRun: vi.fn(),
      installNativeTool: vi.fn(),
      reconcileTools: vi.fn(),
      listTools: vi.fn(),
      queryTools: vi.fn(),
      upsertPlatformTools: vi.fn(),
      setToolEnabled: vi.fn(),
      executeTool: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(platformRoutes, 
      'GET',
      '/api/platform/runtime/health',
      new URL('http://127.0.0.1/api/platform/runtime/health'),
      undefined,
      { platformService },
    )).resolves.toEqual({ status: 200, data: { ok: true } });

    const clawHubService = {
      search: vi.fn(async () => ['skill']),
      login: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
      list: vi.fn(),
      openReadme: vi.fn(),
      openPath: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(clawHubRoutes, 'POST', '/api/clawhub/search', { q: 'x' }, { clawHubService }))
      .resolves.toEqual({ status: 200, data: { success: true, results: ['skill'] } });

    const runtimeHostService = {
      health: vi.fn(),
      transportStats: vi.fn(),
      prepareGatewayLaunch: vi.fn(),
      providerEnvMap: vi.fn(),
      syncProviderAuthBootstrap: vi.fn(),
      runtimeJobs: vi.fn(() => ({ success: true, queue: { stopped: false }, registeredTypes: [], jobs: [] })),
      runtimeJob: vi.fn(),
      collectDiagnostics: vi.fn(),
    };
    await expect(dispatchRuntimeRouteDefinition(runtimeHostRoutes, 
      'GET',
      '/api/runtime-host/jobs',
      new URL('http://127.0.0.1/api/runtime-host/jobs'),
      undefined,
      runtimeHostService,
    )).resolves.toEqual({
      status: 200,
      data: { success: true, queue: { stopped: false }, registeredTypes: [], jobs: [] },
    });
  });
});
