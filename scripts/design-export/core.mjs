const at = Date.UTC(2026, 9, 22, 8);
export const designUser = {
  id: 1, username: 'design-demo', name: '设计示例', email: 'designer@example.test',
  role: 'user', status: 'active', balance: 128, concurrency: 3, allowedGroups: null,
  balanceNotifyEnabled: false, balanceNotifyThreshold: null,
  createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z',
};
const families = ['session', 'task', 'subagent', 'team', 'cron', 'workspace', 'skill', 'channel', 'usage', 'lifecycle', 'board'];
export const designEndpoints = ['openclaw', 'matcha-agent'].map((id) => {
  const capabilities = { chat: true, streaming: true, tools: true, approvals: true, replay: true, modelSelection: true, supportsGoal: id === 'openclaw' };
  return {
    id: `${id}:local`, protocolId: id, runtimeAdapterId: id, runtimeInstanceId: 'local',
    endpointRef: { kind: 'native-runtime', runtimeAdapterId: id, runtimeInstanceId: 'local' },
    source: { kind: 'runtime-adapter', runtimeAdapterId: id, runtimeInstanceId: 'local' },
    location: { kind: 'local' }, lifecycle: { phase: 'ready', ready: true, connected: true, updatedAt: at },
    displayName: id === 'openclaw' ? 'OpenClaw' : 'Matcha Agent', agentIds: ['main', 'researcher'], defaultAgentId: 'main',
    agents: ['main', 'researcher'].map((agentId) => ({ agentId, displayName: agentId === 'main' ? '主助手' : '研究助手', source: 'discovered', capabilities })),
    acceptsDynamicAgents: true, capabilities,
    capabilityFamilies: families.map((family) => ({ family, availability: 'supported' })),
    controlState: {
      connection: { state: 'connected', portReachable: true, gatewayReady: true, healthSummary: 'healthy', transportEpoch: 1, diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 }, updatedAt: at },
      readiness: { ready: true, phase: 'ready', retryable: false }, capabilities: { methods: [], updatedAt: at }, updatedAt: at,
    },
  };
});
const operations = {
  'session.management': ['sessions.list', 'sessions.create', 'sessions.load', 'sessions.window', 'sessions.observe', 'sessions.release', 'sessions.switch', 'sessions.resume', 'sessions.state', 'sessions.rename', 'sessions.archive', 'sessions.unarchive', 'sessions.updateStatus', 'sessions.delete', 'sessions.content.load', 'sessions.permission.get', 'sessions.permission.set'],
  'session.prompt': ['sessions.create', 'sessions.load', 'sessions.prompt', 'sessions.sendWithMedia', 'sessions.abort'], 'session.approval': ['approvals.list', 'approvals.resolve'],
  'session.goal': ['sessions.goal.update', 'sessions.goal.clear'],
  'session.modelSelection': ['sessions.patchModel'], 'session.question': ['sessions.questions.list', 'sessions.questions.respond'],
  'task.management': ['tasks.list', 'tasks.get', 'tasks.create', 'tasks.update', 'todos.get', 'todos.write'],
  'team.runtime': ['team.packageValidate', 'team.dependencyPlan', 'team.provisionAgents', 'team.delete', 'team.runCreate', 'team.runList', 'team.triggerList', 'team.webhookTriggerFire', 'team.runSnapshot', 'team.designStart', 'team.runStart', 'team.designExit', 'team.designSnapshot', 'team.designGraphPatch', 'team.runDiagnostics', 'team.runDecisionSubmit', 'team.resume', 'team.approvalResolve', 'team.graphSave', 'team.graphPatch', 'team.graphContext', 'team.graphExportYaml', 'team.graphImportYaml', 'team.triggerFire', 'team.nodePromptRetryDue', 'team.nodeEvent', 'team.runCancel', 'team.runDelete'],
  'subagent.management': ['subagents.list', 'subagents.displayConfig.get', 'subagents.create', 'subagents.update', 'subagents.delete', 'subagents.description.set', 'subagents.model.set', 'subagents.skills.set', 'subagents.files.get', 'subagents.files.set', 'subagents.files.list', 'subagents.package.export', 'subagents.package.exportCloud', 'subagents.package.install'],
  'scheduler.cron': ['cron.create', 'cron.update', 'cron.delete', 'cron.toggle', 'cron.trigger'],
  'subagent.skills': ['subagentSkills.get', 'subagentSkills.set'],
  'subagent.tools': ['subagentTools.get', 'subagentTools.set'],
  'workspace.file': ['files.readText', 'files.listDir', 'files.readBinary', 'files.stat', 'files.writeText'],
  'workspace.media': ['workspace.media.list', 'workspace.media.read'],
  'skill.management': ['skills.list', 'skills.get', 'skills.refreshStatus', 'clawhub.openReadme', 'clawhub.openPath', 'skills.updateConfig'], 'channel.management': ['channels.list', 'channels.status'],
  'usage.history': ['usage.recent', 'usage.sessionTimeseries'], 'board.management': ['board.snapshot', 'board.list'],
  'openclaw.browser': ['browser.request'], 'openclaw.question': ['question.list', 'question.resolve'],
  'openclaw.canvas': ['canvas.view'], 'openclaw.mcpApp': ['mcp.app.view'], 'openclaw.progress': ['progressCard.get'],
};
function descriptor(id, scope) {
  const endpoint = scope.endpoint ?? scope.identity?.endpoint;
  return {
    id, kind: id, scopeKind: scope.kind, scope, targetKinds: [],
    ...(endpoint ? { runtimeAdapterId: endpoint.runtimeAdapterId, runtimeInstanceId: endpoint.runtimeInstanceId } : {}),
    supportLevel: 'native', availability: 'available',
    operations: (operations[id] ?? []).map((operation) => ({ id: operation, title: operation, targetKind: 'none', targetRequired: false })),
    sessionConfiguration: { permission: true, modelSelection: true },
    policyScope: 'design-fixture', ownerModuleId: id.split('.')[0], routeOwnerId: 'design-fixture',
  };
}
export function coreFixture(path, body, context) {
  if (path === '/api/account/session') return context.scenarioId.startsWith('auth-') ? { state: 'anonymous' } : { state: 'authenticated', user: designUser, expiresAt: null };
  if (path === '/api/account/public-settings') return {
    registrationEnabled: true, emailVerifyEnabled: true, forceEmailOnThirdPartySignup: false,
    registrationEmailSuffixWhitelist: [], promoCodeEnabled: false, passwordResetEnabled: false,
    invitationCodeEnabled: false, turnstileEnabled: false, turnstileSiteKey: '',
    siteName: 'MatchaClaw', siteLogo: '', siteSubtitle: '你的桌面智能工作空间', contactInfo: '', docUrl: '', homeContent: '',
    compactHomeEnabled: true, paymentEnabled: true, linuxdoOauthEnabled: false, wechatOauthEnabled: false,
    oidcOauthEnabled: false, oidcOauthProviderName: '', githubOauthEnabled: false, googleOauthEnabled: false,
    serviceQuotaEnabled: true, affiliateEnabled: false, version: '1.0.5',
  };
  if (path === '/api/gateway/status') return {
    processState: 'running', port: 18789, gatewayReady: true, healthSummary: 'healthy', transportState: 'connected',
    portReachable: true, connectedAt: at, diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 }, updatedAt: at,
  };
  if (path === '/api/gateway/health') return { ok: true, status: 'healthy', connectionState: 'connected', uptime: 7200, portReachable: true, updatedAt: at };
  if (path === '/api/runtime-host/status') return { status: 'running', hostLifecycle: 'ready', runtimeLifecycle: 'running', activePluginCount: 3, enabledPluginIds: ['channels', 'skills', 'search'], updatedAt: at };
  if (path === '/api/platform/tools') return { tools: [
    { id: 'read', name: 'read', description: '读取工作区文件', source: 'native', enabled: true },
    { id: 'write', name: 'write', description: '写入工作区文件', source: 'native', enabled: true },
    { id: 'exec', name: 'exec', description: '执行经过授权的命令', source: 'native', enabled: true },
    { id: 'web_search', name: 'web_search', description: '搜索公开网络资料', source: 'native', enabled: true },
  ] };
  if (path === '/api/runtime-endpoints/list') return { endpoints: designEndpoints };
  if (path === '/api/runtime-adapters/list') return { adapters: designEndpoints.map((e) => ({ runtimeAdapterId: e.runtimeAdapterId, protocolId: e.protocolId, endpointIds: [e.id] })) };
  if (path === '/api/runtime-adapters/instances/list') return { instances: designEndpoints.map((e) => ({ ...e, endpointId: e.id })) };
  if (path === '/api/runtime-connectors/list') return { connectors: [] };
  if (path === '/api/capabilities/list') return { capabilities: designEndpoints.flatMap((e) => Object.keys(operations).flatMap((id) => [
    descriptor(id, { kind: 'runtime-instance', endpoint: e.endpointRef }),
    ...e.agentIds.map((agentId) => descriptor(id, { kind: 'agent', endpoint: e.endpointRef, agentId })),
    ...['agent:main:design-export', 'agent:main:design-notes'].map((sessionKey) => descriptor(id, { kind: 'session', identity: { endpoint: e.endpointRef, agentId: 'main', sessionKey } })),
    descriptor(id, { kind: 'app' }),
  ])) };
  if (path === '/api/capabilities/describe') return { capability: descriptor(body.id, body.scope) };
  if (path === '/api/toolchain/uv/prepare') return { callId: '00000000000000000000000000000001', accepted: true };
  if (path === '/api/toolchain/uv/check') return { installed: true };
  if (path === '/api/plugins/runtime') return { success: true,
    state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 3, enabledPluginIds: ['channels', 'skills', 'search'] },
    health: { ok: true, lifecycle: 'running', activePluginCount: 3, degradedPlugins: [] }, execution: { enabledPluginIds: ['channels', 'skills', 'search'] },
  };
}
export function coreIpc(channel, args, context) {
  if (channel === 'window:isMaximized') return false;
  if (channel === 'hostapi:base-url') return 'http://127.0.0.1:13210';
  if (channel === 'hostapi:abort') return null;
  if (channel === 'update:version') return '1.0.5';
  if (channel === 'update:status' || channel === 'update:check') {
    const status = ['available', 'downloading', 'downloaded', 'error'].find((s) => context.scenarioId === `settings-updates-${s}`) ?? 'idle';
    const update = { status, ...(status !== 'idle' ? { info: { version: '1.0.6', releaseDate: '2026-10-22', releaseNotes: '改进桌面体验，优化运行状态提示。' } } : {}),
      ...(status === 'downloading' ? { progress: { total: 200000000, delta: 0, transferred: 84000000, percent: 42, bytesPerSecond: 4000000 } } : {}),
      ...(status === 'error' ? { error: '示例状态：暂时无法检查更新，请稍后重试。' } : {}),
    };
    return channel === 'update:check' ? { success: true, status: update } : update;
  }
  if (channel === 'diagnostics:exportArchive') return { status: 'saved' };
  if (channel === 'settings:splitProxyIntent') return { proxyServer: '', proxyBypassRules: '<local>;localhost;127.0.0.1;::1' };
  if (['window:minimize', 'window:maximize', 'window:close', 'window:syncTrafficLightPosition', 'shell:openExternal', 'shell:openPath', 'update:setChannel', 'telemetry:track', 'telemetry:trackUiEvent'].includes(channel)) return null;
}
