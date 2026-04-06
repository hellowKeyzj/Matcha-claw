interface OpenClawGatewayClient {
  gatewayRpc: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  isGatewayRunning: (timeoutMs?: number) => Promise<boolean>;
  buildSecurityAuditQueryParams: (url: URL) => Record<string, string>;
}

export interface OpenClawBridge {
  gatewayRpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  chatSend: (params: Record<string, unknown>) => Promise<unknown>;
  channelsStatus: (probe?: boolean) => Promise<unknown>;
  channelsConnect: (channelId: string) => Promise<unknown>;
  channelsDisconnect: (channelId: string) => Promise<unknown>;
  channelsRequestQr: (channelType: string) => Promise<unknown>;
  isGatewayRunning: () => Promise<boolean>;
  platformInstallTool: (source: Record<string, unknown>) => Promise<{ toolId?: string; id?: string }>;
  platformUninstallTool: (toolId: string) => Promise<void>;
  platformEnableTool: (toolId: string) => Promise<void>;
  platformDisableTool: (toolId: string) => Promise<void>;
  platformListToolsCatalog: () => Promise<unknown>;
  platformStartRun: (context: Record<string, unknown>, eventTx?: unknown) => Promise<{ runId?: string; id?: string }>;
  platformAbortRun: (runId: string) => Promise<void>;
  securityPolicySync: (policy: unknown) => Promise<unknown>;
  securityAuditQueryFromUrl: (url: URL) => Promise<unknown>;
  securityQuickAuditRun: () => Promise<unknown>;
  securityEmergencyRun: () => Promise<unknown>;
  securityIntegrityCheck: () => Promise<unknown>;
  securityIntegrityRebaseline: () => Promise<unknown>;
  securitySkillsScan: (scanPath?: string) => Promise<unknown>;
  securityAdvisoriesCheck: (feedUrl?: string | null) => Promise<unknown>;
  securityRemediationPreview: () => Promise<unknown>;
  securityRemediationApply: (actions: string[]) => Promise<unknown>;
  securityRemediationRollback: (snapshotId?: string) => Promise<unknown>;
  listCronJobs: (includeDisabled?: boolean) => Promise<unknown>;
  addCronJob: (payload: Record<string, unknown>) => Promise<unknown>;
  updateCronJob: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  removeCronJob: (id: string) => Promise<unknown>;
  runCronJob: (id: string, mode?: 'force' | 'due') => Promise<unknown>;
}

export function createOpenClawBridge(client: OpenClawGatewayClient): OpenClawBridge {
  return {
    gatewayRpc: (method, params = {}, timeoutMs) => client.gatewayRpc(method, params, timeoutMs),
    chatSend: (params) => client.gatewayRpc('chat.send', params, 120000),
    channelsStatus: (probe = true) => client.gatewayRpc('channels.status', { probe }, 10000),
    channelsConnect: (channelId) => client.gatewayRpc('channels.connect', { channelId }, 10000),
    channelsDisconnect: (channelId) => client.gatewayRpc('channels.disconnect', { channelId }, 10000),
    channelsRequestQr: (channelType) => client.gatewayRpc('channels.requestQr', { type: channelType }, 12000),
    isGatewayRunning: () => client.isGatewayRunning(),
    platformInstallTool: (source) => client.gatewayRpc('plugins.install', source) as Promise<{ toolId?: string; id?: string }>,
    platformUninstallTool: async (toolId) => {
      await client.gatewayRpc('plugins.uninstall', { toolId });
    },
    platformEnableTool: async (toolId) => {
      await client.gatewayRpc('plugins.enable', { toolId });
    },
    platformDisableTool: async (toolId) => {
      await client.gatewayRpc('plugins.disable', { toolId });
    },
    platformListToolsCatalog: () => client.gatewayRpc('tools.catalog', { includePlugins: true }),
    platformStartRun: (context, eventTx) => {
      return client.gatewayRpc('agent.run', { context, eventTx }) as Promise<{ runId?: string; id?: string }>;
    },
    platformAbortRun: async (runId) => {
      await client.gatewayRpc('agent.abort', { runId });
    },
    securityPolicySync: (policy) => client.gatewayRpc('security.policy.sync', policy, 8000),
    securityAuditQueryFromUrl: (url) => {
      return client.gatewayRpc('security.audit.query', client.buildSecurityAuditQueryParams(url), 8000);
    },
    securityQuickAuditRun: () => client.gatewayRpc('security.quick_audit.run', {}, 45000),
    securityEmergencyRun: () => client.gatewayRpc('security.emergency.run', {}, 45000),
    securityIntegrityCheck: () => client.gatewayRpc('security.integrity.check', {}),
    securityIntegrityRebaseline: () => client.gatewayRpc('security.integrity.rebaseline', {}),
    securitySkillsScan: (scanPath) => client.gatewayRpc('security.skills.scan', scanPath ? { scanPath } : {}),
    securityAdvisoriesCheck: (feedUrl) => client.gatewayRpc('security.advisories.check', feedUrl ? { feedUrl } : {}),
    securityRemediationPreview: () => client.gatewayRpc('security.remediation.preview', {}),
    securityRemediationApply: (actions) => {
      return client.gatewayRpc(
        'security.remediation.apply',
        actions.length > 0 ? { actions } : {},
        20000,
      );
    },
    securityRemediationRollback: (snapshotId) => {
      return client.gatewayRpc(
        'security.remediation.rollback',
        snapshotId ? { snapshotId } : {},
      );
    },
    listCronJobs: (includeDisabled = true) => client.gatewayRpc('cron.list', { includeDisabled }),
    addCronJob: (payload) => client.gatewayRpc('cron.add', payload),
    updateCronJob: (id, patch) => client.gatewayRpc('cron.update', { id, patch }),
    removeCronJob: (id) => client.gatewayRpc('cron.remove', { id }),
    runCronJob: (id, mode = 'force') => client.gatewayRpc('cron.run', { id, mode }),
  };
}
