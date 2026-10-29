const at = Date.UTC(2026, 9, 22, 8);
const sessionId = '11111111-2222-4333-8444-555555555555';
const endpoint = (runtimeAdapterId) => ({ kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId: 'local' });
const qrDataUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="white"/><path fill="#202328" d="M16 16h64v64H16zm8 8v48h48V24zm8 8h32v32H32zm128-16h64v64h-64zm8 8v48h48V24zm8 8h32v32h-32zM16 160h64v64H16zm8 8v48h48v-48zm8 8h32v32H32zM96 16h16v32H96zm32 16h16v48h-16zM96 64h16v32H96zm16 32h32v16h-32zM16 96h32v16H16zm48 0h16v32H64zm32 32h16v32H96zm32-16h16v32h-16zm32-16h32v16h-32zm48 16h16v32h-16zM16 128h32v16H16zm144 0h16v32h-16zm32 16h16v16h-16zm-80 32h32v16h-32zm48 0h32v16h-32zm48 0h16v48h-16zm-112 32h16v16H96zm32 0h48v16h-48zm48-16h16v16h-16z"/><rect x="89" y="89" width="62" height="62" rx="8" fill="white"/><text x="120" y="117" text-anchor="middle" font-size="10" font-family="sans-serif">DESIGN</text><text x="120" y="132" text-anchor="middle" font-size="9" font-family="sans-serif">示例二维码</text></svg>')}`;
const skillRows = [
  { skillKey: 'core-memory', name: '核心记忆', description: '维护会话上下文与长期记忆，为助手提供连续的工作体验。', bundled: true, always: true, source: 'openclaw-bundled', eligible: true, selectable: true, version: '1.2.0' },
  { skillKey: 'browser-research', slug: 'browser-research', name: '网页研究助手', description: '整理公开网页、交叉核对资料并输出带来源的研究摘要。', source: 'openclaw-managed', eligible: true, selectable: true, uninstallable: true, author: 'Matcha 示例团队', version: '2.1.0', baseDir: 'C:/DesignDemo/skills/browser-research' },
  { skillKey: 'document-studio', slug: 'document-studio', name: '文档工作室', description: '将零散笔记整理成结构清晰、便于协作的项目文档。', source: 'openclaw-managed', disabled: true, eligible: true, selectable: false, unavailableReason: 'disabled', uninstallable: true, version: '1.4.0' },
  { skillKey: 'data-insights', slug: 'data-insights', name: '数据洞察', description: '分析表格并提取关键趋势；当前示例展示缺少依赖时的状态。', source: 'openclaw-managed', eligible: false, selectable: false, unavailableReason: 'missingRequirements', missingCategories: ['binaries', 'environment'], missing: { bins: ['python'], env: ['DEMO_DATA_URL'], anyBins: [], config: [], os: [] }, uninstallable: true, version: '1.0.0' },
  { skillKey: 'desktop-automation', name: '桌面自动化', description: '演示不满足当前平台条件的能力。', bundled: true, source: 'openclaw-bundled', eligible: false, selectable: false, unavailableReason: 'ineligible', version: '1.0.0' },
  { skillKey: 'team-handbook', name: '团队知识手册', description: '将团队约定与协作规范封装为只读技能包。', source: 'matcha-sealed', eligible: true, selectable: true, version: '1.3.0' },
  { skillKey: 'workspace-notes', name: '工作区笔记', description: '工作区发现的技能，等待运行时报告可用性。', source: 'openclaw-workspace', version: '0.8.0' },
];
const marketplace = [
  { slug: 'web-platform-atlas', name: '网页平台图谱', description: '观察页面能力、梳理常用操作并归档可复用的网页工作流。', version: '1.5.0', author: 'Atlas 示例工作室', downloads: 12480, stars: 326 },
  { slug: 'browser-research', name: '网页研究助手', description: '搜索与整理公开资料，让每一条研究结论都有据可查。', version: '2.1.0', author: 'Matcha 示例团队', downloads: 8360, stars: 214 },
  { slug: 'meeting-brief', name: '会议简报', description: '提炼讨论要点、行动项与责任分工，生成清晰的会议简报。', version: '1.2.0', author: '协作示例团队', downloads: 5620, stars: 168 },
];
const cloudPackages = [
  { packageId: 'design-skill-handbook', packageVersionId: 'design-skill-v1', name: 'team-handbook', displayName: '团队知识手册', packageType: 'skill', version: '1.3.0', description: '团队协作规范与项目知识的只读技能包。', status: 'published', downloadable: true, entitlementStatus: 'granted', downloadCount: 246, createdAt: '2026-10-01T08:00:00Z' },
  { packageId: 'design-skill-analysis', packageVersionId: 'design-skill-analysis-v2', name: 'analysis-methods', displayName: '分析方法工具箱', packageType: 'skill', version: '2.0.0', description: '覆盖问题拆解、信息核验与结论写作的分析方法。', status: 'published', downloadable: true, entitlementStatus: 'granted', downloadCount: 108, createdAt: '2026-10-15T08:00:00Z' },
];
const connectors = [
  { id: 'docs-mcp', kind: 'mcp-stdio', displayName: '文档 MCP', description: '为助手提供示例项目文档的检索与目录浏览能力。', enabled: true, mcpServerProgram: { source: 'managed-local', programId: 'design-docs-server' }, secretEnv: { DOCS_TOKEN: { kind: 'secret-ref', ref: 'secret:design-docs-token' } } },
  { id: 'research-mcp', kind: 'mcp-http', displayName: '研究 MCP', description: '通过远程 MCP 服务查询公开研究资料。', enabled: true, url: 'https://mcp.example.test/research', transport: 'streamable-http', connectionTimeoutMs: 10000, secretHeaders: { Authorization: { kind: 'secret-ref', ref: 'secret:design-research-token' } } },
  { id: 'project-cli', kind: 'cli', displayName: '项目工具 CLI', description: '演示由本地命令提供的项目管理能力。', enabled: false },
  { id: 'billing-sdk', kind: 'sdk', displayName: '业务数据 SDK', description: '使用 SDK 查询合成业务数据，私有配置不在公共接口回读。', enabled: true, provider: 'design-business', packageName: '@example/business-sdk', secretConfigRefs: { apiKey: { kind: 'secret-ref', ref: 'secret:design-business-key' } } },
  { id: 'status-http', kind: 'http', displayName: '服务状态 HTTP', description: '查询服务的公开状态与运行公告。', enabled: true, baseUrl: 'https://status.example.test/api', secretHeaders: {} },
];
const plugins = [
  { id: 'channels', name: '消息渠道', kind: 'builtin', enabled: true, description: '连接消息平台，让团队在熟悉的频道中与助手协作。' },
  { id: 'browser-workbench', name: '浏览器工作台', kind: 'third-party', enabled: true, description: '提供网页观察、资料提取与可复用的浏览器工作流。', companionSkillSlugs: ['browser-research', 'web-platform-atlas'] },
  { id: 'document-tools', name: '文档工具', kind: 'third-party', enabled: false, description: '为文档整理、格式转换与知识归档提供扩展能力。' },
].map((plugin) => ({ runtime: 'openclaw', version: '1.2.0', platform: 'openclaw', installed: true, updateAvailable: false, companionSkillReady: true, ...plugin }));
const policy = {
  preset: 'balanced', securityPolicyVersion: 1,
  runtime: {
    runtimeGuardEnabled: true, auditOnGatewayStart: true, autoHarden: false, enablePromptInjectionGuard: true, blockDestructive: true, blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: true }, logging: { logDetections: true },
    allowPathPrefixes: ['C:/DesignDemo/workspace'], allowDomains: ['docs.example.test'], auditEgressAllowlist: ['api.example.test'], auditDailyCostLimitUsd: 10, auditFailureMode: 'safe_mode',
    promptInjectionPatterns: ['ignore previous instructions'], allowlist: { tools: ['fs_read_file', 'web_search'], sessions: ['agent:main:design-export'] },
    destructive: { action: 'confirm', severityActions: { critical: 'block', high: 'block', medium: 'confirm', low: 'warn' }, categories: { fileDelete: true, gitDestructive: true, sqlDestructive: true, systemDestructive: true, processKill: true, networkDestructive: true, privilegeEscalation: true } },
    secrets: { action: 'redact', severityActions: { critical: 'block', high: 'block', medium: 'redact', low: 'warn' } },
    destructivePatterns: ['delete-all-demo-files'], secretPatterns: ['DEMO_PRIVATE_VALUE_[A-Z0-9]+'],
  },
};
const remediationActions = [
  { id: 'design-egress', title: '收紧审计外联范围', description: '仅保留当前示例项目明确需要的服务域名。', risk: 'medium' },
  { id: 'design-baseline', title: '更新配置文件基线', description: '为已确认的配置保存完整性基线，便于后续核验。', risk: 'low' },
];
const states = new Map();
function stateFor(context) {
  const key = context.scenarioId;
  if (!states.has(key)) states.set(key, { skills: structuredClone(skillRows), connectors: structuredClone(connectors), plugins: structuredClone(plugins), policy: structuredClone(policy), calls: new Map(), results: new Map(), sequence: 0 });
  return states.get(key);
}
function receipt(state, module, command, detail, result) {
  const callId = `de5100000000000000000000${(++state.sequence).toString(16).padStart(8, '0')}`;
  state.calls.set(callId, { callId, module, command, status: 'succeeded', start: at, end: at + 45, revision: 1, detail });
  if (result) state.results.set(callId, { callId, command, result });
  return { callId, accepted: true };
}
function connectorStatuses(state) {
  return state.connectors.map((connector) => ({ connectorId: connector.id, resultType: !connector.enabled ? 'disabled' : connector.id === 'research-mcp' ? 'disconnected' : ['sdk', 'cli'].includes(connector.kind) ? 'unsupported' : 'connected', safeProbe: ['mcp-http', 'http'].includes(connector.kind), ...(connector.enabled && ['http', 'mcp-stdio'].includes(connector.kind) ? { latencyMs: 24 } : {}) }));
}
function skillsStatus(state, native) {
  return { skills: state.skills.map((skill) => native ? { ...skill, source: skill.source === 'matcha-sealed' ? 'matcha-sealed' : 'native-agent-candidate', disabled: false, bundled: false, always: false } : skill), ready: true, refreshing: false, updatedAt: at, error: null };
}
function channelSnapshot(native) {
  const rows = native ? [['weixin', 'design-weixin', 'design-weixin', false]] : [
    ['feishu', 'default', '团队协作机器人', true], ['qqbot', 'default', '产品答疑机器人', true], ['wecom', 'default', '企业服务机器人', false],
  ];
  return { success: true, ready: true, refreshing: false, updatedAt: at, snapshot: {
    channelOrder: rows.map(([type]) => type), channels: Object.fromEntries(rows.map(([type]) => [type, { configured: true }])),
    channelAccounts: Object.fromEntries(rows.map(([type, accountId, name, connected]) => [type, [{ accountId, name, configured: true, connected, running: connected, linked: connected, lastError: type === 'wecom' ? '示例状态：凭证需要更新，请检查配置。' : undefined }]])),
    channelDefaultAccountId: Object.fromEntries(rows.map(([type, accountId]) => [type, accountId])),
  } };
}
function channelReceipt(state, body, operation) {
  return receipt(state, 'channels', operation, { operation, channel: body.channel, accountId: body.accountId ?? null, phase: 'complete', outcome: 'confirmed', reply: 'confirmed', configFinalization: 'confirmed' });
}

export function toolsFixture(path, body, context) {
  const state = stateFor(context);
  const url = new URL(context.url || path, 'http://design.invalid');
  const native = context.scenarioId.includes('-native-') || body?.scope?.endpoint?.runtimeAdapterId === 'matcha-agent' || url.searchParams.get('runtimeAdapterId') === 'matcha-agent';
  if (path === '/api/calls/get' && state.calls.has(body?.callId)) return state.calls.get(body.callId);
  if (path === '/api/channels/snapshot') return channelSnapshot(native);
  if (path === '/api/channels/config/read') {
    const values = body.channel === 'weixin' ? { sessionId, enabled: 'true' } : body.accountId ? {
      feishu: { appId: 'cli_design_demo', appSecret: 'synthetic-example-only' }, qqbot: { appId: 'design-qq-app', clientSecret: 'synthetic-example-only' }, wecom: { botId: 'design-wecom-bot', secret: 'synthetic-example-only' },
    }[body.channel] ?? {} : {};
    return { success: true, values, agentId: body.accountId ? 'main' : null };
  }
  if (path === '/api/channels/configure') return { outcome: 'confirmed' };
  if (path === '/api/channels/credentials/validate') return { success: true, valid: true, errors: [], warnings: ['合成示例：凭证格式校验通过，未访问真实平台。'], details: { botUsername: 'design_demo_bot' } };
  if (path === '/api/channels/pairing') return body.action === 'approve' ? { outcome: 'confirmed' } : { requests: [{ id: 'DESIGN8A', status: 'pending' }, { id: 'DESIGN2B', status: 'pending' }] };
  if (path === '/api/channels/delete-config') return channelReceipt(state, body, 'deleteConfig');
  if (path === '/api/channels/control') return body.action === 'disconnect' ? channelReceipt(state, body, 'disconnect') : body.action === 'connect' ? { outcome: 'confirmed' } : undefined;
  if (path === '/api/channels/login' || path === '/api/channels/authorization') {
    // Native wait is a long poll; keep the real pending-authorization UI without a busy retry loop.
    if (body.action === 'wait') return new Promise(() => {});
    if (body.action === 'cancel') return { outcome: 'cancelled' };
    if (body.action === 'logout') return channelReceipt(state, body, 'logout');
    if (body.action === 'start') return { outcome: 'progress', channel: body.channel, accountId: body.accountId, sessionKey: 'design-authorization-session', ...(context.scenarioId.endsWith('-link') ? {} : { qrDataUrl }), ...(path.endsWith('/authorization') ? { authorizationUrl: 'https://authorization.example.test/design', expiresAt: at + 300000 } : {}) };
  }
  if (path === '/api/openclaw/skills-dir') return 'C:/DesignDemo/skills';
  if (path === '/api/skills/status') return skillsStatus(state, native);
  if (path === '/api/clawhub/search') {
    const query = (body.query ?? '').toLowerCase();
    return { success: true, results: marketplace.filter((skill) => !query || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(query)) };
  }
  if (path === '/api/skills/readme') return { success: true, content: body.skillKey === 'team-handbook' ? '# 团队知识手册\n\n汇总团队约定、项目资料与协作规范。\n\n## 协作约定\n明确目标与责任分工，记录关键决策，交付前核对结果。\n\n## 使用方式\n告诉助手你的项目背景、工作目标与所需资料。' : '# 网页研究助手\n\n检索公开信息，核对来源并整理研究摘要。\n\n## 使用方式\n告诉助手研究主题、时间范围与期望输出。' };
  if (path === '/api/sealed-skills/status') return { skills: [{ skillKey: 'team-handbook', name: '团队知识手册', description: '团队约定、项目资料与协作规范的只读技能包。', installed: true, version: '1.3.0', source: 'matcha-sealed', runtimes: ['openclaw', 'matcha-agent'] }], issues: context.scenarioId.includes('-issues') ? [{ fileName: 'legacy-demo.matcha-skillpkg', skillKey: 'legacy-demo', reason: 'missing-authorization-key' }] : [], error: null };
  if (path === '/api/packages/installed') return { packages: [
    { packageVersionId: 'design-skill-v1', packageType: 'skill', packageSha256: 'b'.repeat(64), fileName: 'team-handbook.matcha-skillpkg' },
    { packageVersionId: 'design-agent-market-research-v1', packageType: 'agent', packageSha256: 'a'.repeat(64), fileName: 'research-agent.matcha-agent' },
  ] };
  if (['/api/packages/market', '/api/packages/mine'].includes(path) && url.searchParams.get('packageType') === 'skill') {
    const items = path.endsWith('/mine') ? [{ ...cloudPackages[0], packageVersionId: 'design-skill-draft-v2', status: 'draft', version: '1.4.0', downloadable: false }, cloudPackages[1]] : cloudPackages;
    return { items, total: items.length, page: 1, pageSize: 20, pages: 1 };
  }
  if (path === '/api/skills/operations/result' && state.results.has(body.callId)) return state.results.get(body.callId);
  if (path === '/api/skills/config' || path === '/api/capabilities/execute' && body.id === 'skill.management' && body.operationId === 'skills.updateConfig') {
    const input = body.input ?? body;
    if (typeof input.enabled === 'boolean') state.skills = state.skills.map((skill) => skill.skillKey === input.skillKey ? { ...skill, disabled: !input.enabled, unavailableReason: input.enabled ? null : 'disabled' } : skill);
    const command = path === '/api/skills/config' ? 'skills.config' : 'skills.updateConfig';
    return receipt(state, 'skills', command, { access: 'write', skillKey: input.skillKey, ...(input.enabled === undefined ? {} : { enabled: input.enabled }), resultReady: true, result: 'accepted' }, { kind: 'config', outcome: 'accepted', skillKey: input.skillKey, invalidKeys: [] });
  }
  if (path === '/api/capabilities/execute' && body.id === 'skill.management') {
    if (body.operationId === 'skills.refreshStatus') return skillsStatus(state, native);
    if (body.operationId === 'skills.updateBatchState') {
      const { skillKeys, enabled } = body.input;
      state.skills = state.skills.map((skill) => skillKeys.includes(skill.skillKey) ? { ...skill, disabled: !enabled, unavailableReason: enabled ? null : 'disabled' } : skill);
      return receipt(state, 'skills', body.operationId, { access: 'write', enabled, resultReady: true, result: 'accepted', requestedCount: skillKeys.length, updatedCount: skillKeys.length, invalidCount: 0, failedCount: 0 }, { kind: 'batchState', success: true, outcome: 'accepted', enabled, requested: skillKeys, updated: skillKeys, invalidKeys: [], failed: [] });
    }
  }
  if (path === '/api/skills/clawhub/install') {
    const skill = marketplace.find((item) => item.slug === body.slug);
    if (!skill) return undefined;
    state.skills.push({ ...skill, skillKey: skill.slug, source: 'openclaw-managed', eligible: true, selectable: true, uninstallable: true });
    return receipt(state, 'skills', 'skills.clawhub.install', { access: 'write', slug: body.slug, ...(body.version ? { version: body.version } : {}), outcome: 'accepted' });
  }
  if (path === '/api/skills/uninstall' || path === '/api/sealed-skills/uninstall') {
    state.skills = state.skills.filter((skill) => skill.skillKey !== body.skillKey);
    return receipt(state, 'skills', path.includes('/sealed-skills/') ? 'sealedSkills.uninstall' : 'skills.uninstall', { access: 'write', skillKey: body.skillKey, ...(body.slug ? { slug: body.slug } : {}), outcome: 'removed' });
  }
  if (path === '/api/plugins/runtime') {
    const enabledPluginIds = state.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
    return { success: true, state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: enabledPluginIds.length, enabledPluginIds }, health: { ok: true, lifecycle: 'running', activePluginCount: enabledPluginIds.length, degradedPlugins: [] }, execution: { enabledPluginIds } };
  }
  if (path === '/api/plugins/catalog') return native ? { success: true, agentId: url.searchParams.get('agentId') ?? 'main', sessionState: 'not_observed', plugins: state.plugins.map((plugin, index) => ({ runtime: 'matcha-agent', id: plugin.id, version: plugin.version, scope: index === 0 ? 'managed' : 'user', enabled: plugin.enabled, errorCount: index === 2 ? 1 : 0 })) } : { success: true, execution: { enabledPluginIds: state.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id) }, plugins: state.plugins };
  if (path === '/api/plugins/configuration') {
    state.plugins = state.plugins.map((plugin) => plugin.id === body.pluginId ? { ...plugin, enabled: body.enabled } : plugin);
    return receipt(state, 'plugins', 'configuration', { kind: 'configuration', pluginId: body.pluginId, enabled: body.enabled, outcome: 'configured' });
  }
  if (path === '/api/security') return state.policy;
  if (path === '/api/security/audit') return { items: [
    { ts: at - 60000, toolName: 'system_run', risk: 'high', action: 'block', decision: '破坏性命令已阻断', ruleId: 'DESTRUCTIVE-001' },
    { ts: at - 180000, toolName: 'http_request', risk: 'medium', action: 'audit', decision: '外联域名位于允许范围', ruleId: 'EGRESS-002' },
    { ts: at - 360000, toolName: 'fs_read_file', risk: 'low', action: 'allow', decision: '工作区内只读访问已放行', ruleId: 'PATH-003' },
  ] };
  if (path === '/api/security/destructive-rule-catalog') return { success: true, items: [
    { platform: 'universal', command: 'git reset --hard', category: 'git_destructive', severity: 'high', reason: '丢弃未提交的工作区修改' },
    { platform: 'linux', command: 'rm -rf <path>', category: 'file_delete', severity: 'critical', reason: '递归强删目录树' },
    { platform: 'windows', command: 'rd /s /q <path>', category: 'file_delete', severity: 'high', reason: '递归删除目录树' },
    { platform: 'macos', command: 'diskutil eraseDisk', category: 'system_destructive', severity: 'critical', reason: '磁盘抹除/重分区' },
    { platform: 'powershell', command: 'Remove-Item -Recurse -Force', category: 'file_delete', severity: 'high', reason: '强制/递归删除文件' },
  ] };
  if (path === '/api/security/policy' && body.operationId === 'security.replace') {
    state.policy = body.input.policy;
    return receipt(state, 'security', 'security.replace', { kind: 'policyReplace', correlation: 'design-policy-replace', revision: 2, effect: 'confirmed' });
  }
  if (path === '/api/security/emergency') return receipt(state, 'security', 'security.emergency', { kind: 'emergency', correlation: 'design-emergency', outcome: 'applied' });
  if (path === '/api/security/operation' && body.id === 'security.operation' && ['quickAudit', 'checkIntegrity', 'rebaselineIntegrity', 'scanSkills', 'checkAdvisories', 'previewRemediation', 'applyRemediation', 'rollbackRemediation'].some((operation) => body.operationId === `security.${operation}`)) return receipt(state, 'security', body.operationId, { kind: 'operation', correlation: body.operationId, operation: body.operationId.slice(9), outcome: 'confirmed' });
  if (path === '/api/security/operation/receipt') {
    if (body.operationId === 'security.previewRemediation') return { actions: remediationActions };
    if (body.operationId === 'security.applyRemediation') return { snapshotId: 'design-remediation-snapshot', applied: remediationActions.map((action) => action.id) };
    if (body.operationId === 'security.quickAudit') return { findings: [{ id: 'DESIGN-AUDIT-001', severity: 'info', message: '合成示例安全检查完成，未发现高风险项。' }], checkedAt: '2026-10-22T08:00:00Z' };
    if (body.operationId === 'security.checkIntegrity') return { files: [{ path: 'design/config.json', status: 'unchanged' }], changed: 0 };
    if (body.operationId === 'security.rebaselineIntegrity') return { baselineId: 'design-baseline', files: 4 };
    if (body.operationId === 'security.scanSkills') return { scanned: 7, findings: [] };
    if (body.operationId === 'security.checkAdvisories') return { advisories: [], checkedAt: '2026-10-22T08:00:00Z' };
    if (body.operationId === 'security.rollbackRemediation') return { snapshotId: 'design-remediation-snapshot', restored: true };
  }
  if (path === '/api/external-connectors') return { connectors: state.connectors };
  if (path === '/api/external-connectors/mcp-server-programs') return { programs: [
    { id: 'design-docs-server', source: 'managed-local', displayName: '文档检索服务', connectorKinds: ['mcp-stdio'] },
    { id: 'design-remote-server', source: 'external-url', displayName: '远程研究服务', connectorKinds: ['mcp-http'], transport: 'streamable-http' },
  ] };
  if (path === '/api/openclaw/mcp-servers') return { servers: [
    { serverId: 'matcha-builtin', displayName: 'Matcha 内置工具', description: '预置的工作区与任务工具。', kind: 'mcp-stdio', source: 'preset', enabled: true, managed: true, editable: false, removable: false },
    { serverId: 'runtime-notes', displayName: '原生笔记服务', description: '运行时发现的 MCP 服务。', kind: 'mcp-http', source: 'openclaw', enabled: true, managed: false, editable: false, removable: false },
    ...state.connectors.filter((connector) => connector.kind.startsWith('mcp-')).map((connector) => ({ serverId: connector.id, connectorId: connector.id, displayName: connector.displayName, description: connector.description, kind: connector.kind, source: 'external', enabled: connector.enabled, managed: true, editable: true, removable: true })),
  ] };
  if (path === '/api/external-connectors/session-status') {
    const statuses = body.sessionIdentity.endpoint.runtimeAdapterId === 'openclaw' ? [
      { connectorId: 'docs-mcp', displayName: '文档 MCP', adapterId: 'openclaw', targetKind: 'session', resultType: 'connected', details: { serverId: 'docs-mcp', toolCount: 8, enabledNextRun: true, enabledConfigurable: true } },
      { connectorId: 'research-mcp', displayName: '研究 MCP', adapterId: 'openclaw', targetKind: 'session', resultType: 'pending', reason: '示例服务等待当前会话完成连接。', details: { serverId: 'research-mcp', enabledNextRun: true, enabledConfigurable: true } },
    ] : [];
    const admission = receipt(state, 'connectors', 'externalConnectors.sessionStatus', { result: 'available', count: statuses.length, summariesTruncated: false });
    state.results.set(admission.callId, { callId: admission.callId, kind: 'sessionStatus', sessionIdentity: body.sessionIdentity, statuses });
    return admission;
  }
  if (path === '/api/external-connectors/session-mcp-server-enabled') return receipt(state, 'connectors', 'externalConnectors.sessionMcpServerEnabled', { result: 'applied-next-run', serverId: body.serverId, enabled: body.enabled, summariesTruncated: false });
  if (path === '/api/external-connectors/status' || path === '/api/external-connectors/probe') {
    const kind = path.endsWith('/probe') ? 'probe' : 'status';
    const statuses = connectorStatuses(state);
    const admission = receipt(state, 'connectors', `externalConnectors.${kind}`, { result: 'available', ...(kind === 'probe' ? { connectorId: body.connectorId } : { count: statuses.length, observations: statuses.map(({ connectorId, resultType }) => ({ connectorId, resultType })) }), summariesTruncated: false });
    state.results.set(admission.callId, kind === 'probe' ? { callId: admission.callId, kind, status: { connectorId: body.connectorId, resultType: 'connected', latencyMs: 18, safeProbe: true } } : { callId: admission.callId, kind, statuses });
    return admission;
  }
  if (path === '/api/external-connectors/observation-result' && state.results.has(body.callId)) return state.results.get(body.callId);
  if (path === '/api/external-connectors/get') {
    const connector = state.connectors.find((item) => item.id === body.connectorId);
    return connector ? { connector } : undefined;
  }
  if (path === '/api/external-connectors/update' || path === '/api/external-connectors/upsert') {
    const creating = path.endsWith('/upsert');
    const input = creating ? body.connector : { ...state.connectors.find((item) => item.id === body.connectorId), ...body.patch };
    const { command, args, cwd, env, headers, config, ...summary } = input;
    state.connectors = [...state.connectors.filter((item) => item.id !== summary.id), summary];
    return receipt(state, 'connectors', `externalConnectors.${creating ? 'upsert' : 'update'}`, { connectorId: summary.id, result: 'stored', revision: state.sequence + 1, created: creating, projection: 'written', changed: true, summariesTruncated: false });
  }
  if (path === '/api/external-connectors/remove') {
    state.connectors = state.connectors.filter((item) => item.id !== body.connectorId);
    return receipt(state, 'connectors', 'externalConnectors.remove', { connectorId: body.connectorId, result: 'removed', revision: state.sequence + 1, tombstoned: true, projection: 'written', changed: true, summariesTruncated: false });
  }
  return undefined;
}

const button = (name, index) => ({ role: 'button', name, exact: true, ...(index === undefined ? {} : { index }) });
const tab = (name) => ({ role: 'tab', name, exact: true });
const scene = (id, title, group, route, sources, actions = [], waitFor, extra = {}) => ({ id, title, group, route, sources, actions, ...(waitFor ? { waitFor } : {}), ...extra });
const channelsSource = ['src/plugins/channels/page.tsx', 'src/plugins/channels/store.ts', 'src/types/channel.ts'];
const skillsSource = ['src/plugins/skills/page.tsx', 'src/plugins/skills/stores/skills.ts', 'src/plugins/skills/stores/sealed-skills.ts'];
const pluginsSource = ['src/plugins/native-plugins/page/index.tsx', 'src/plugins/native-plugins/store.ts'];
const securitySource = ['src/plugins/security/index.tsx', 'src/plugins/security/security-policy-store.ts', 'src/plugins/security/security-support-store.ts'];
const connectorsSource = ['src/plugins/connectors/page.tsx', 'src/plugins/connectors/store.ts'];
const channelKinds = [['weixin', 'WeChat', '生成二维码'], ['qqbot', 'QQ Bot', '开始授权'], ['dingtalk', 'DingTalk', '开始授权'], ['wecom', 'WeCom', '保存并连接'], ['feishu', 'Feishu / Lark', '开始授权']];
async function openChannel(page, name) {
  await page.getByRole('button', { name: '添加频道', exact: true }).click();
  await page.locator('button').filter({ has: page.locator('p', { hasText: name }) }).filter({ hasText: name }).last().click();
  await page.locator('#name').waitFor();
}
const newConnectorFields = {
  'mcp-stdio': [['command', 'npx'], ['args', '-y\n@example/docs-mcp'], ['env', 'DOCS_LOCALE=zh-CN']],
  'mcp-http': [['url', 'https://mcp.example.test/new'], ['timeout', '10000']],
  cli: [['command', 'design-cli'], ['args', 'project\nstatus']],
  sdk: [['provider', 'design-business'], ['package', '@example/business-sdk'], ['config', '{\n  "region": "demo"\n}']],
  http: [['base-url', 'https://api.example.test/v1'], ['headers', 'Accept=application/json']],
};

export const toolsScenarios = [
  scene('channels-overview', '消息频道 · 已配置与可用频道', '渠道', '/channels', channelsSource, [], '团队协作机器人'),
  scene('channels-add-catalog', '添加频道 · 类型目录', '渠道', '/channels', channelsSource, [button('添加频道')], '选择要配置的频道类型'),
  ...channelKinds.map(([id, name, submit]) => scene(`channels-add-${id}`, `新增 ${name} · 连接配置`, '渠道', '/channels', channelsSource, [], submit, { prepare: async (page) => openChannel(page, name) })),
  ...channelKinds.filter(([id]) => ['qqbot', 'dingtalk', 'feishu'].includes(id)).map(([id, name]) => scene(`channels-add-${id}-credentials`, `新增 ${name} · 凭证配置`, '渠道', '/channels', channelsSource, [button('通过配置连接')], '保存并连接', { prepare: async (page) => openChannel(page, name) })),
  scene('channels-weixin-advanced', '微信 · 高级设置', '渠道', '/channels', channelsSource, [button('高级设置（可选）')], '服务地址（可选）', { prepare: async (page) => openChannel(page, 'WeChat') }),
  scene('channels-weixin-qr', '微信 · 等待扫码', '渠道', '/channels', channelsSource, [button('生成二维码')], '等待扫码或授权完成...', { prepare: async (page) => openChannel(page, 'WeChat') }),
  ...[['qqbot', 'QQ Bot'], ['dingtalk', 'DingTalk'], ['feishu', 'Feishu / Lark']].map(([id, name]) => scene(`channels-${id}-qr`, `${name} · 扫码授权`, '渠道', '/channels', channelsSource, [button('开始授权')], '等待扫码或授权完成...', { prepare: async (page) => openChannel(page, name) })),
  scene('channels-feishu-link', '飞书 · 链接授权', '渠道', '/channels', channelsSource, [button('开始授权')], '打开授权链接', { prepare: async (page) => openChannel(page, 'Feishu / Lark') }),
  ...[['feishu', '团队协作机器人', 'Feishu / Lark'], ['qqbot', '产品答疑机器人', 'QQ Bot'], ['wecom', '企业服务机器人', 'WeCom']].map(([id, name, type]) => scene(`channels-edit-${id}`, `编辑 ${name}`, '渠道', '/channels', channelsSource, [button(`配置 ${name}`)], `更新 ${type}`)),
  scene('channels-agent-picker', '频道配置 · 智能体选择', '渠道', '/channels', channelsSource, [{ css: '#channel-agent' }], '研究助手', { prepare: async (page) => openChannel(page, 'WeChat') }),
  scene('channels-credential-validation', '企业微信 · 凭证校验结果', '渠道', '/channels', channelsSource, [{ css: '#botId', fill: 'design-demo-bot' }, { css: '#secret', fill: 'synthetic-example-only' }, button('验证配置')], '凭证已验证', { prepare: async (page) => openChannel(page, 'WeCom') }),
  scene('channels-pairing', '飞书 · 用户绑定管理', '渠道', '/channels', channelsSource, [button('管理用户绑定')], 'DESIGN8A'),
  scene('channels-delete-confirm', '删除频道 · 确认', '渠道', '/channels', channelsSource, [{ css: 'button:has(svg.lucide-trash-2)', index: 0 }], '确定要删除此渠道及其所有账号吗？'),
  scene('channels-native-overview', 'Matcha Agent · 微信绑定列表', '渠道', '/channels', channelsSource, [], 'design-weixin'),
  scene('channels-native-add', 'Matcha Agent · 新增微信绑定', '渠道', '/channels', channelsSource, [button('添加频道')], '微信 · Matcha 原生绑定'),
  scene('channels-native-edit', 'Matcha Agent · 编辑微信绑定', '渠道', '/channels', channelsSource, [button('配置 design-weixin')], '停止消费'),
  scene('channels-native-pairing', 'Matcha Agent · 配对审批', '渠道', '/channels', channelsSource, [button('配置 design-weixin'), { css: 'input[aria-label="六位微信配对码"]', fill: '123456' }], '批准配对'),
  scene('channels-native-qr', 'Matcha Agent · 原生登录扫码', '渠道', '/channels', channelsSource, [button('配置 design-weixin'), button('原生登录')], '这是原生流程首次返回的二维码', { notes: '原生登录等待由合成长轮询保持；二维码不用于真实授权。' }),
  scene('skills-all-grid', '技能 · 全部技能', '技能', '/skills', skillsSource, [], '网页研究助手'),
  scene('skills-all-list', '技能 · 列表视图', '技能', '/skills', skillsSource, [button('列表视图')], '网页研究助手'),
  ...[['built-in', '内置技能', '核心记忆'], ['managed', '用户安装', '网页研究助手']].map(([source, title, wait]) => scene(`skills-source-${source}`, `技能 · ${title}`, '技能', '/skills', skillsSource, [{ css: 'select[aria-label="来源"]', select: source }], wait)),
  ...[['enabled', '已启用', '网页研究助手'], ['disabled', '已禁用', '文档工作室'], ['eligible', '可用', '网页研究助手'], ['missing', '缺少依赖', '数据洞察'], ['unselectable', '不可选择', '桌面自动化'], ['unknown', '状态未知', '工作区笔记']].map(([status, title, wait]) => scene(`skills-status-${status}`, `技能 · ${title}`, '技能', '/skills', skillsSource, [{ css: 'select[aria-label="状态"]', select: status }], wait)),
  scene('skills-search-empty', '技能 · 无匹配结果', '技能', '/skills', skillsSource, [{ css: 'input[aria-label="搜索技能..."]', fill: '不存在的示例技能' }], '尝试不同的搜索词'),
  scene('skills-detail-info', '技能详情 · 信息', '技能', '/skills', skillsSource, [button('网页研究助手')], '打开手册'),
  scene('skills-detail-config', '技能详情 · 配置', '技能', '/skills', skillsSource, [button('网页研究助手'), tab('配置')], '保存配置'),
  scene('skills-detail-env', '技能详情 · 环境变量编辑', '技能', '/skills', skillsSource, [button('网页研究助手'), tab('配置'), button('添加变量'), { css: 'input[placeholder="键名 (例如 BASE_URL)"]', fill: 'BASE_URL' }, { css: 'input[placeholder="值"]', fill: 'https://api.example.test' }], '键名为空的行将在保存时自动移除'),
  scene('skills-detail-core', '核心技能 · 只读详情', '技能', '/skills', skillsSource, [button('核心记忆')], '维护会话上下文与长期记忆'),
  scene('skills-detail-missing', '技能详情 · 缺少依赖', '技能', '/skills', skillsSource, [button('数据洞察')], 'bin:python'),
  scene('skills-marketplace-grid', '市场 · 发现技能', '技能', '/skills', skillsSource, [tab('市场')], '网页平台图谱'),
  scene('skills-marketplace-list', '市场 · 列表视图', '技能', '/skills', skillsSource, [tab('市场'), button('列表视图')], '网页平台图谱'),
  scene('skills-marketplace-search', '市场 · 搜索结果', '技能', '/skills', skillsSource, [tab('市场'), { css: 'input[aria-label="搜索市场..."]', fill: '会议' }], '会议简报'),
  scene('skills-marketplace-detail', '市场 · 技能详情与安装', '技能', '/skills', skillsSource, [tab('市场'), button('网页平台图谱')], '安装前请点击技能卡片'),
  scene('skills-marketplace-installed-detail', '市场 · 已安装技能详情', '技能', '/skills', skillsSource, [tab('市场'), button('网页研究助手')], '安装前请点击技能卡片'),
  scene('skills-upload', '市场 · 上传本地技能', '技能', '/skills', skillsSource, [tab('市场'), button('上传技能')], '拖拽技能文件或点击选择'),
  scene('skills-sealed-installed', '技能包 · 已安装', '技能', '/skills', skillsSource, [tab('技能包')], '团队知识手册'),
  scene('skills-sealed-installed-list', '技能包 · 已安装列表视图', '技能', '/skills', skillsSource, [tab('技能包'), button('列表视图')], '团队知识手册'),
  scene('skills-sealed-issues', '技能包 · 授权异常提示', '技能', '/skills', skillsSource, [tab('技能包')], 'legacy-demo.matcha-skillpkg'),
  scene('skills-sealed-mine', '技能包 · 我的云端包', '技能', '/skills', skillsSource, [tab('技能包'), tab('我的云端包')], '草稿'),
  scene('skills-sealed-market', '技能包 · 云端市场', '技能', '/skills', skillsSource, [tab('技能包'), tab('云端市场')], '分析方法工具箱'),
  scene('skills-sealed-export', '技能包 · 导出技能', '技能', '/skills', skillsSource, [tab('技能包'), button('导出技能')], '选择技能并导出为加密技能包'),
  scene('skills-sealed-install', '技能包 · 安装本地包', '技能', '/skills', skillsSource, [tab('技能包'), button('安装本地包')], '拖拽 .matcha-skillpkg 或点击选择'),
  scene('skills-sealed-menu', '技能包 · 操作菜单', '技能', '/skills', skillsSource, [tab('技能包'), button('技能包操作: 团队知识手册')], '上传云端'),
  scene('skills-sealed-uninstall', '技能包 · 卸载确认', '技能', '/skills', skillsSource, [tab('技能包'), button('技能包操作: 团队知识手册'), { role: 'menuitem', name: '卸载', exact: true }], '从本地技能包中移除 团队知识手册'),
  scene('skills-native-overview', 'Matcha Agent · 技能候选', '技能', '/skills', skillsSource, [], '网页研究助手'),
  scene('skills-native-detail', 'Matcha Agent · 技能详情', '技能', '/skills', skillsSource, [button('网页研究助手')], '打开手册'),
  scene('skills-native-readme', 'Matcha Agent · 技能手册', '技能', '/skills', skillsSource, [button('网页研究助手'), button('打开手册')], '# 网页研究助手'),
  scene('skills-native-upload', 'Matcha Agent · ZIP 技能上传', '技能', '/skills', skillsSource, [tab('市场'), button('上传技能')], '上传技能'),
  scene('skills-native-sealed', 'Matcha Agent · 已安装技能包', '技能', '/skills', skillsSource, [tab('技能包')], '当前会话加载未确认'),
  scene('plugins-grid', '插件 · 网格视图', '插件', '/plugins', pluginsSource, [], '浏览器工作台'),
  scene('plugins-list', '插件 · 列表视图', '插件', '/plugins', pluginsSource, [button('列表视图')], '浏览器工作台'),
  scene('plugins-list-details', '插件 · 展开说明', '插件', '/plugins', pluginsSource, [], 'browser-workbench', { prepare: async (page) => { await page.getByRole('button', { name: '列表视图', exact: true }).click(); await page.locator('summary').filter({ hasText: '提供网页观察、资料提取与可复用的浏览器工作流。' }).click(); } }),
  ...[['builtin', '内置', '消息渠道'], ['third-party', '第三方', '浏览器工作台']].map(([kind, title, wait]) => scene(`plugins-kind-${kind}`, `插件 · ${title}`, '插件', '/plugins', pluginsSource, [{ css: 'select[aria-label="类型"]', select: kind }], wait)),
  ...[['enabled', '已启用', '浏览器工作台'], ['disabled', '未启用', '文档工具']].map(([status, title, wait]) => scene(`plugins-status-${status}`, `插件 · ${title}`, '插件', '/plugins', pluginsSource, [{ css: 'select[aria-label="启用状态"]', select: status }], wait)),
  scene('plugins-native-grid', 'Matcha Agent · 原生插件', '插件', '/plugins', pluginsSource, [], 'browser-workbench'),
  scene('plugins-native-list', 'Matcha Agent · 原生插件列表', '插件', '/plugins', pluginsSource, [button('列表视图')], 'browser-workbench'),
  ...[['runtime', '运行时开关', '防护模式与运行时守卫'], ['matrix', '动作矩阵', '破坏性风险 默认动作'], ['rule-catalog', '规则覆盖', 'git reset --hard'], ['allowlist', '白名单与扩展正则', '一键写入已启用工具'], ['policy-guards', '策略防护扩展', '允许路径前缀'], ['action-center', '安全动作中心', '常规体检'], ['audit-hits', '最近命中审计', 'DESTRUCTIVE-001']].map(([id, title, wait]) => scene(`security-${id}`, `安全 · ${title}`, '安全', '/security', securitySource, [button(title)], wait)),
  ...[['allowlistSessions', '会话白名单'], ['destructivePatterns', '破坏性扩展规则'], ['secretPatterns', '敏感信息扩展规则']].map(([id, title]) => scene(`security-${id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, `安全 · ${title}`, '安全', '/security', securitySource, [button('白名单与扩展正则'), tab(title)], title)),
  ...[['linux', 'Linux', 'rm -rf'], ['windows', 'Windows', 'rd /s /q'], ['macos', 'macOS', 'diskutil eraseDisk'], ['powershell', 'PowerShell', 'Remove-Item']].map(([platform, title, wait]) => scene(`security-rules-${platform}`, `规则覆盖 · ${title}`, '安全', '/security', securitySource, [button('规则覆盖'), { css: '#rule-catalog-platform', select: platform }], wait)),
  scene('security-preset-strict', '安全 · 严格防护模式', '安全', '/security', securitySource, [{ css: '#security-preset', select: 'strict' }], '未保存改动'),
  scene('security-quick-audit', '安全动作 · 体检结果', '安全', '/security', securitySource, [button('安全动作中心'), button('常规体检')], 'DESIGN-AUDIT-001'),
  scene('security-remediation-preview', '安全动作 · 修复预览', '安全', '/security', securitySource, [button('安全动作中心'), button('修复预览')], '收紧审计外联范围'),
  scene('security-remediation-applied', '安全动作 · 修复结果', '安全', '/security', securitySource, [button('安全动作中心'), button('修复预览'), button('应用勾选修复')], 'design-remediation-snapshot'),
  scene('security-emergency', '安全动作 · 紧急止损结果', '安全', '/security', securitySource, [button('安全动作中心'), button('紧急止损')], 'applied'),
  scene('connectors-grid', '连接器 · 全部协议', '连接器', '/connectors', connectorsSource, [], '文档 MCP'),
  scene('connectors-list', '连接器 · 列表视图', '连接器', '/connectors', connectorsSource, [button('列表视图')], '文档 MCP'),
  ...Object.entries(newConnectorFields).map(([kind, fields]) => scene(`connectors-add-${kind}`, `新增连接器 · ${kind}`, '连接器', '/connectors', connectorsSource, [], '创建连接器', { prepare: async (page) => {
    await page.getByRole('button', { name: '新增连接器', exact: true }).click();
    await page.locator('#connector-kind').selectOption(kind);
    await page.locator('#connector-id').fill(`design-new-${kind}`);
    await page.locator('#connector-name').fill(`示例 ${kind} 服务`);
    await page.locator('#connector-description').fill('仅用于设计交接的合成配置，不会访问真实服务。');
    for (const [field, value] of fields) await page.locator(`#connector-${field}`).fill(value);
  } })),
  ...connectors.map((connector) => scene(`connectors-edit-${connector.kind}`, `编辑连接器 · ${connector.kind}`, '连接器', '/connectors', connectorsSource, [button(`编辑 ${connector.displayName}`, 0)], '私有执行配置不回读')),
  scene('connectors-edit-private', '连接器 · 显式替换私有配置', '连接器', '/connectors', connectorsSource, [], '替换 command', { prepare: async (page) => { await page.getByRole('button', { name: '编辑 文档 MCP', exact: true }).first().click(); await page.locator('label').filter({ hasText: '替换 command' }).getByRole('switch').click(); await page.locator('#connector-command').fill('design-docs-server'); }, notes: '仅显式开启的私有字段可替换；不回读已有 command/args/cwd/env。' }),
  ...[['mcp-stdio', '文档 MCP'], ['mcp-http', '研究 MCP'], ['cli', '项目工具 CLI'], ['sdk', '业务数据 SDK'], ['http', '服务状态 HTTP']].map(([kind, wait]) => scene(`connectors-filter-${kind}`, `连接器 · ${kind} 协议筛选`, '连接器', '/connectors', connectorsSource, [{ css: 'select[aria-label="协议类型"]', select: kind }], wait)),
  scene('connectors-disabled', '连接器 · 未启用筛选', '连接器', '/connectors', connectorsSource, [{ css: 'select[aria-label="启用状态"]', select: 'disabled' }], '项目工具 CLI'),
  scene('connectors-probe', '连接器 · 探测结果', '连接器', '/connectors', connectorsSource, [button('检测 研究 MCP')], '研究 MCP'),
  scene('connectors-native-overview', 'Matcha Agent · MCP 与连接器', '连接器', '/connectors', connectorsSource, [], 'Matcha 原生'),
];

export async function seedTools(context) {
  if (!toolsScenarios.some((scenario) => scenario.id === context.scenarioId)) return;
  const { useRuntimeEndpointsStore } = await import('/src/plugins/runtime/directory.ts');
  useRuntimeEndpointsStore.setState({ managementEndpoint: endpoint(context.scenarioId.includes('-native-') ? 'matcha-agent' : 'openclaw') });
}
