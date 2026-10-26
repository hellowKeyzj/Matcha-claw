const now = Date.now();
const day = 86400000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
const model = 'demo-openai/gpt-5.5';
const sessionKey = 'agent:main:design-export';
const workspace = 'C:/MatchaDesign/workspace';
const agents = [
  { id: 'main', name: '主助手', description: '统筹工作计划，协调研究与交付，并在关键节点请求人工确认。', workspace, model, skills: ['team-handbook'], kind: 'agent', isDefault: true, identity: { name: '主助手', theme: '沉稳、清晰、注重交付' } },
  { id: 'researcher', name: '研究助手', description: '收集公开资料、核对证据，整理可追溯的研究结论。', workspace: 'C:/MatchaDesign/workspace-researcher', model, skills: ['team-handbook', 'web-research'], kind: 'agent', isDefault: false, identity: { name: '研究助手', theme: '严谨、好奇、尊重事实' } },
];
const tasks = [
  { id: 'design-task-101', subject: '整理产品访谈与研究证据', description: '汇总三组虚构访谈记录，提炼用户目标、使用障碍与待验证假设。\n\n交付：研究摘要、证据索引、下一轮访谈提纲。示例资料均为人工合成，不含真实用户数据。', status: 'in_progress', owner: '研究助手', blockedBy: [], blocks: ['design-task-102', 'design-task-104'], activeForm: '正在归纳访谈主题与证据', metadata: { priority: 'high' }, createdAt: now - 2 * day, updatedAt: now - 12 * 60000 },
  { id: 'design-task-102', subject: '制定工作台改版方案', description: '根据研究摘要，形成信息架构与主要交互路径。\n\n验收：覆盖任务列表、详情、空状态及异常恢复，标注需要设计评审的决策点。', status: 'pending', owner: '主助手', blockedBy: ['design-task-101'], blocks: ['design-task-105'], activeForm: '等待研究摘要', createdAt: now - day, updatedAt: now - 30 * 60000 },
  { id: 'design-task-103', subject: '完成现有流程与页面盘点', description: '已整理页面入口、操作清单和跨页面跳转关系，产物已交付至合成工作区。', status: 'completed', owner: '主助手', blockedBy: [], blocks: [], createdAt: now - 5 * day, updatedAt: now - day },
  { id: 'design-task-104', subject: '核对外部投递与权限边界', description: '检查定时任务的投递目标和账户归属，确保执行前可以明确识别影响范围。', status: 'pending', owner: '研究助手', blockedBy: ['design-task-101'], blocks: [], createdAt: now - day, updatedAt: now - 40 * 60000 },
  { id: 'design-task-105', subject: '准备跨职能方案评审', description: '汇总待决问题、备选方案与验收标准，邀请负责人确认上线顺序。', status: 'pending', owner: '主助手', blockedBy: ['design-task-102'], blocks: [], createdAt: now - 3 * 3600000, updatedAt: now - 3600000 },
  { id: 'design-task-106', subject: '归档项目交付检查清单', description: '交付检查清单已完成，保留资料来源、责任人和验收记录。', status: 'completed', owner: '研究助手', blockedBy: [], blocks: [], createdAt: now - 8 * day, updatedAt: now - 3 * day },
];
const cronBase = { agentId: 'main', model, enabled: true, systemManaged: false, createdAt: iso(-14 * day), updatedAt: iso(-day), delivery: { mode: 'none' } };
const cronJobs = [
  { ...cronBase, id: 'design-cron-daily', name: '每日工作摘要', message: '汇总今天的项目进展、待处理事项与风险，输出一份精简的工作摘要。', schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' }, lastRun: { time: iso(-day), success: true, duration: 18340 }, nextRun: iso(day) },
  { ...cronBase, id: 'design-cron-running', name: '研究资料定期整理', agentId: 'researcher', message: '检查研究资料收集箱，按主题更新证据索引，并列出尚待核实的引用。', schedule: { kind: 'every', everyMs: 3600000 }, runningAt: iso(-45000), lastRun: { time: iso(-3600000), success: true, duration: 25600 }, nextRun: iso(3600000) },
  { ...cronBase, id: 'design-cron-paused', name: '每周复盘提醒', message: '整理本周已完成事项、反复出现的问题与下周重点。', enabled: false, schedule: { kind: 'cron', expr: '0 17 * * 5', tz: 'Asia/Shanghai' }, lastRun: { time: iso(-7 * day), success: true, duration: 14600 } },
  { ...cronBase, id: 'design-cron-external', name: '团队进展推送', message: '生成一段适合协作群阅读的进展说明：本周成果、当前阻塞、需要协助的事项。', schedule: { kind: 'cron', expr: '30 17 * * 1-5', tz: 'Asia/Shanghai' }, delivery: { mode: 'announce', channel: 'feishu', accountId: 'default', to: 'oc_design_review' }, lastRun: { time: iso(-day), success: false, error: '示例投递目标暂时不可用，请核对接收方后重试。', duration: 3200 }, nextRun: iso(day) },
  { ...cronBase, id: 'design-cron-once', name: '方案评审前检查', message: '在评审前检查方案摘要、待决问题与验收清单是否齐全。', schedule: { kind: 'at', at: iso(3 * day) }, nextRun: iso(3 * day) },
];
const personaFiles = {
  'AGENTS.md': '# 研究助手工作约定\n\n## 职责\n收集公开资料、核对证据、输出可追溯的研究摘要。\n\n## 工作方式\n先澄清研究问题，再记录事实与推断。每个关键结论附资料来源；证据不足时明确说明。\n\n## 交付\n使用简洁中文，优先给结论、证据与下一步。所有本页内容均为人工合成示例。',
  'SOUL.md': '# 人设\n\n严谨而不生硬，保持好奇，不把猜测写成事实。\n\n面对不同观点先还原其依据，再说明判断。遇到信息缺口时直接指出，不编造资料或引用。',
  'USER.md': '# 协作偏好\n\n使用中文。优先列出结论和关键证据，避免重复解释。\n\n外部发送、删除资料或改变权限前，先让负责人确认。',
  'MEMORY.md': '# 项目记忆\n\n示例项目：协作工作台体验研究。\n当前目标：让任务进展、责任人和待审批事项更容易被发现。\n本文件仅含人工合成内容，不读取任何真实工作区。',
};
const templateSpecs = [
  ['design-research', '研究分析助手', '围绕明确问题收集公开资料，核对来源，交付可追溯的研究摘要。', '研究与分析'],
  ['design-project', '项目协作助手', '拆解目标、跟踪依赖和风险，整理清晰的项目进展。', '项目与协作'],
  ['design-writing', '内容编辑助手', '梳理叙事结构、统一表达风格，并保留事实与引用边界。', '内容与创作'],
  ['design-review', '方案评审助手', '按目标、约束和验收标准检查方案，输出有依据的改进建议。', '项目与协作'],
  ['design-data', '数据洞察助手', '说明分析口径、识别异常，将数据转化为可执行的建议。', '研究与分析'],
  ['design-support', '客户支持助手', '理解问题上下文，给出可操作的排查步骤与升级材料。', '服务与支持'],
];
const templateRoot = 'C:/MatchaDesign/templates';
const templates = templateSpecs.map(([id, name, summary, categoryId], order) => ({ id, name, summary, categoryId, order, sourcePath: `${templateRoot}/${id}`, files: Object.keys(personaFiles) }));
const skillOptions = [
  { skillKey: 'team-handbook', displayName: '团队工作手册', description: '读取团队约定、交付规范和项目背景。', selectable: true },
  { skillKey: 'web-research', displayName: '公开资料研究', description: '收集资料并整理证据索引与引用。', selectable: true },
  { skillKey: 'writing-review', displayName: '内容审校', description: '检查结构、表达与事实一致性。', selectable: true },
  { skillKey: 'data-analysis', displayName: '数据分析', description: '分析表格与统计结果。', selectable: false, unavailableReason: 'missingRequirements', missingRequirements: { bins: ['python3'], anyBins: [], env: [], config: [], os: [] } },
];
function skillConfig(agentId) {
  const explicit = agentId === 'researcher';
  return { agentId, support: { supportType: 'supported' }, selectionMode: explicit ? 'usesExplicitSkillAllowlist' : 'inheritsDefaultSkills', explicitSkillKeys: explicit ? ['team-handbook', 'web-research'] : [], inheritedDefaultSkillKeys: ['team-handbook'], effectiveSkillKeys: explicit ? ['team-handbook', 'web-research'] : ['team-handbook'], options: skillOptions, revision: 'design-skills-1', updatedAt: now };
}
const toolOptions = [
  { toolKey: 'read', displayName: '读取文件', optionType: 'tool', description: '读取当前工作区内的文件内容。', source: 'core', risk: 'low', defaultProfiles: ['coding', 'full'], deniedByGlobalPolicy: false, groupKey: 'files', groupDisplayName: '文件与工作区' },
  { toolKey: 'write', displayName: '写入文件', optionType: 'tool', description: '创建或更新工作区文件。', source: 'core', risk: 'medium', defaultProfiles: ['coding', 'full'], deniedByGlobalPolicy: false, groupKey: 'files', groupDisplayName: '文件与工作区' },
  { toolKey: 'web_fetch', displayName: '读取网页', optionType: 'tool', description: '获取公开网页内容。', source: 'core', risk: 'low', defaultProfiles: ['full'], deniedByGlobalPolicy: false, groupKey: 'web', groupDisplayName: '网页与资料' },
  { toolKey: 'browser', displayName: '浏览器', optionType: 'tool', description: '在授权的浏览器中观察页面并执行操作。', source: 'core', risk: 'medium', defaultProfiles: ['full'], deniedByGlobalPolicy: false, groupKey: 'web', groupDisplayName: '网页与资料' },
  { toolKey: 'exec', displayName: '执行命令', optionType: 'tool', description: '执行本地命令，使用前需遵守权限约定。', source: 'core', risk: 'high', defaultProfiles: ['coding', 'full'], deniedByGlobalPolicy: false, groupKey: 'runtime', groupDisplayName: '运行与执行' },
];
function toolConfig(agentId) {
  return { agentId, support: { supportType: 'supported' }, selectionMode: 'usesAgentToolPolicy', toolPolicy: { profile: 'coding', allow: ['web_fetch'], deny: ['exec'] }, toolProfiles: [{ profileKey: 'minimal', displayName: '最小权限' }, { profileKey: 'coding', displayName: '开发与文件' }, { profileKey: 'full', displayName: '全部工具' }], toolGroups: ['files', 'web', 'runtime'].map((groupKey) => ({ groupKey, displayName: toolOptions.find((tool) => tool.groupKey === groupKey).groupDisplayName, source: 'core', toolOptions: toolOptions.filter((tool) => tool.groupKey === groupKey) })), toolOptions, revision: 'design-tools-1', updatedAt: now };
}
const packageBase = { packageType: 'agent', version: '1.0.0', downloadable: true, status: 'published', createdAt: iso(-14 * day), updatedAt: iso(-day) };
const marketPackages = [
  { ...packageBase, packageId: 'design-agent-market-research', packageVersionId: 'design-agent-market-research-v1', name: 'research-agent', displayName: '证据研究助手', description: '从研究问题到证据摘要，附清晰的资料核验与引用约定。', entitlementStatus: 'available', downloadCount: 128 },
  { ...packageBase, packageId: 'design-agent-market-review', packageVersionId: 'design-agent-market-review-v1', name: 'review-agent', displayName: '交付评审助手', description: '检查方案目标、风险与验收标准，让评审更聚焦。', entitlementStatus: 'available', downloadCount: 64 },
];
const myPackages = [
  { ...packageBase, packageId: 'design-agent-mine-project', packageVersionId: 'design-agent-mine-project-v1', name: 'project-agent', displayName: '项目协作助手', description: '团队内部使用的工作约定与交付清单。', status: 'draft', downloadable: false },
  { ...packageBase, packageId: 'design-agent-mine-writing', packageVersionId: 'design-agent-mine-writing-v1', name: 'writing-agent', displayName: '内容编辑助手', description: '统一内容结构、语言风格与引用规范。', downloadCount: 12 },
];

export function workflowsFixture(path, body, context = {}) {
  const url = new URL(context.url || path, 'http://design.invalid');
  if (path === '/api/subagents/agents' && body?.id === 'subagent.management') {
    if (body.operationId === 'subagents.list') return { agents, defaultId: 'main', selectionRequired: false, mainKey: 'main', scope: 'local', ready: true, refreshing: false, updatedAt: now, error: null };
    if (body.operationId === 'subagents.displayConfig.get') return { agents: agents.map(({ id, description, workspace, model, skills }) => ({ id, description, workspace, model, skills })), defaults: { workspace, model, skills: ['team-handbook'] }, ready: true, refreshing: false, updatedAt: now, error: null };
    if (body.operationId === 'subagents.files.get' && personaFiles[body.input?.name]) return { file: { name: body.input.name, content: personaFiles[body.input.name] } };
    return undefined;
  }
  if (path === '/api/capabilities/execute') {
    if (body?.id === 'task.management') {
      const key = body.input?.sessionIdentity?.sessionKey ?? body.scope?.identity?.sessionKey;
      const scopedTasks = key === sessionKey ? tasks : [];
      if (body.operationId === 'tasks.list') return { scope: { type: 'session', key: key || sessionKey, label: '工作台体验研究', sessionKey: key || sessionKey, agentId: 'main' }, tasks: scopedTasks, todos: [] };
      if (body.operationId === 'tasks.get') return { task: scopedTasks.find((task) => task.id === body.input?.taskId) ?? null };
      if (body.operationId === 'todos.get') return { todos: [], updatedAt: now };
    }
    if (body?.id === 'subagent.skills' && body.operationId === 'subagentSkills.get') return skillConfig(body.input?.agentId ?? 'main');
    if (body?.id === 'subagent.tools' && body.operationId === 'subagentTools.get') return toolConfig(body.input?.agentId ?? 'main');
    return teamFixture(body, context);
  }
  if (path === '/api/cron/jobs') return { success: true, jobs: cronJobs, ready: true, refreshing: false, updatedAt: now, error: null };
  if (path === '/api/openclaw/subagent-templates') return { sourceDir: templateRoot, categories: [...new Set(templates.map((template) => template.categoryId))].map((id, order) => ({ id, order })), templates };
  if (path.startsWith('/api/openclaw/subagent-templates/')) {
    const template = templates.find((item) => item.id === decodeURIComponent(path.slice('/api/openclaw/subagent-templates/'.length)));
    if (template) return { sourceDir: templateRoot, template: { ...template, fileContents: { ...personaFiles, 'AGENTS.md': `# ${template.name}\n\n${template.summary}\n\n先明确目标，保留证据边界，交付简洁的中文结论。本文件为人工合成示例。` } } };
  }
  if (url.searchParams.get('packageType') === 'agent') {
    const items = path === '/api/packages/market' ? marketPackages : path === '/api/packages/mine' ? myPackages : undefined;
    if (items) return { items, total: items.length, page: 1, pageSize: 20, pages: 1 };
  }
  if (path === '/api/runtime-host/team-webhook-auth') return { success: true, enabled: true, source: 'settings', headerName: 'x-matchaclaw-webhook-token', authorizationScheme: 'Bearer', maskedToken: '••••••••design', copySupported: false };
  return undefined;
}

const teamId = 'design-team-research';
const activeRunId = 'teamrun-design01-current';
const previousRunId = 'teamrun-design00-previous';
const team = { id: teamId, runtimeScope: { kind: 'agent', endpoint, agentId: 'main' }, name: '产品研究协作组', teamSkillName: 'research-review', teamSkillVersion: '1.0.0', teamSkillDescription: '研究、审核与人工确认组成的协作工作流。', packagePath: 'C:/MatchaDesign/team-skills/research-review', sourcePath: 'C:/MatchaDesign/team-skills/research-review', sourceType: 'teamskill', activeRunId, createdAt: now - 14 * day, updatedAt: now - 1800000 };
function teamRoles(runId) {
  return [['leader', 'main'], ['researcher', 'researcher']].map(([roleId, agentId]) => {
    const localSessionId = `agent:${agentId}:team-design-export-${roleId}${runId === previousRunId ? '-previous' : ''}`;
    return { teamId, runId, roleId, sessionRef: 'initial', status: 'available', agentId, endpointRef: endpoint, localSessionId, endpointSessionId: localSessionId, sessionIdentity: { endpoint, agentId, sessionKey: localSessionId } };
  });
}
function runRecord(runId, context = {}) {
  const previous = runId === previousRunId;
  return { runId, status: previous ? 'completed' : context.scenarioId === 'teams-approval' ? 'waiting_for_user' : 'running', revision: previous ? 24 : 12, currentStageId: previous ? 'delivery' : 'review', packageName: 'research-review', packageVersion: '1.0.0', sourcePath: team.sourcePath, createdAt: now - (previous ? 7 * day : 3 * 3600000), updatedAt: now - (previous ? 6 * day : 120000) };
}
const nodePorts = { start: ['completed'], work: ['completed'], review: ['completed', 'rework'], human_decision: ['approved', 'rejected', 'aborted'], script_review: ['passed', 'failed'], join: ['joined'], end: [] };
function graphNode(nodeId, kind, title, status, config = {}, roleId = null, taskId = null) {
  const sourcePorts = nodePorts[kind];
  return { nodeId, kind, title, roleId, taskId, maxAttempts: 3, status, statusReason: status === 'waiting_for_user' ? '等待负责人确认交付方案。' : null, config, sourcePorts, targetPorts: kind === 'start' ? [] : ['input'], sourcePortActions: Object.fromEntries(sourcePorts.map((port) => [port, port === 'rework' ? ['rework'] : ['rejected', 'aborted', 'failed'].includes(port) ? ['activate', 'rework', 'gate', 'finish'] : ['activate', 'gate', 'finish']])) };
}
function teamGraph(runId) {
  const previous = runId === previousRunId;
  const nodes = [
    graphNode('start', 'start', '研究任务入口', 'completed', { trigger: { mode: 'webhook', path: 'design-review' } }),
    graphNode('research', 'work', '资料研究', 'completed', { prompt: '围绕协作工作台的使用目标收集公开资料，区分事实、推断与待验证假设。\n\n交付研究摘要与证据索引，每个关键结论保留来源。所有任务背景均为人工合成。', outputArtifactKind: 'research-summary', sessionRef: 'initial' }, 'researcher', 'design-team-task-research'),
    graphNode('review', 'review', '方案审核', 'completed', { prompt: '核对研究摘要的证据、结论和交付范围。若证据不足，列出具体问题并退回研究节点；通过后提交人工确认。', sessionRef: 'initial' }, 'leader', 'design-team-task-review'),
    graphNode('approval', 'human_decision', '交付方案确认', previous ? 'completed' : 'waiting_for_user'),
    graphNode('quality', 'script_review', '交付完整性检查', 'completed', { rule: 'assert_artifact_exists' }),
    graphNode('join', 'join', '汇合研究与确认结果', previous ? 'completed' : 'pending'),
    graphNode('end', 'end', '交付研究结论', previous ? 'completed' : 'pending'),
  ];
  const edge = (edgeId, sourceNodeId, targetNodeId, sourcePort, action = 'activate') => ({ edgeId, sourceNodeId, targetNodeId, sourcePort, targetPort: 'input', action, payload: { includeUpstreamResult: true }, dependency: null, status: previous || ['start', 'research', 'review', 'quality'].includes(sourceNodeId) ? 'available' : 'waiting' });
  return { runId, graphId: `graph-${runId}`, workflowPlanId: null, title: '产品研究与交付确认', layout: { nodePositions: { start: { x: 0, y: 0 }, research: { x: 300, y: 0 }, review: { x: 600, y: 0 }, approval: { x: 900, y: 0 }, quality: { x: 300, y: 300 }, join: { x: 600, y: 300 }, end: { x: 900, y: 300 } } }, nodes, edges: [edge('start-research', 'start', 'research', 'completed'), edge('research-review', 'research', 'review', 'completed'), edge('research-quality', 'research', 'quality', 'completed'), edge('review-approval', 'review', 'approval', 'completed'), { ...edge('review-rework', 'review', 'research', 'rework', 'rework'), status: 'waiting' }, edge('quality-join', 'quality', 'join', 'passed', 'gate'), edge('approval-join', 'approval', 'join', 'approved', 'gate'), edge('join-end', 'join', 'end', 'joined', 'finish')], status: previous ? 'completed' : 'running' };
}
function teamDesign(runId) {
  return { success: true, teamId, runId, startGate: { status: 'started' }, graphVersion: (runId === previousRunId ? 'b' : 'a').repeat(64), designEpoch: null, graph: teamGraph(runId), roles: teamRoles(runId), runtimeError: null };
}
function teamSnapshot(runId, context = {}) {
  const run = runRecord(runId, context);
  const graph = teamGraph(runId);
  const approvals = context.scenarioId === 'teams-approval' && runId === activeRunId ? [{ approvalId: 'design-approval-delivery', runId, subject: 'human_decision', nodeId: 'approval', stageId: 'review', roleId: 'leader', reason: '即将向项目协作群投递研究结论，需要负责人核对交付范围与接收方。', requestedAction: '确认研究摘要与证据索引，可以向合成项目协作群交付。', risk: 'medium', status: 'pending', idempotencyKey: 'design-approval-delivery-1', createdAt: now - 300000 }] : [];
  return { run, graph, nodeInputStates: [], nodeExecutions: graph.nodes.filter((node) => node.status === 'completed').map((node, index) => ({ runId, nodeId: node.nodeId, nodeExecutionId: `execution-${node.nodeId}`, attemptId: `attempt-${node.nodeId}-1`, attemptNumber: 1, status: 'completed', summary: '已完成当前节点要求，产物通过交付检查。', startedAt: now - 7200000 + index * 60000, completedAt: now - 7140000 + index * 60000 })), nodeDeliveries: [], roles: teamRoles(runId), stages: [], workflowPlan: null, dispatchGroups: [], dispatchTasks: [], approvals, artifacts: [], dispatches: [], dispatchExecutions: [], messages: [], nodePromptDeliveries: [], gates: [], kickbacks: [], decisions: [], diagnostics: { runId, recoveredFromStorage: false, storageRoot: `C:/MatchaDesign/teams/${teamId}/${runId}`, budgets: { totalWallClockBudgetMs: 3600000, totalTokenBudget: 120000, roleWallClockBudgetMs: {}, roleTokenBudget: {}, elapsedMs: 720000, wallClockExceeded: false }, limits: { maxArtifactContentBytes: 1048576, maxMessageBodyBytes: 65536, staleDispatchExecutionMs: 300000 }, staleDispatchExecutions: [], counts: { nodes: graph.nodes.length, edges: graph.edges.length, roles: 2, approvals: approvals.length } }, events: [{ eventId: `${runId}-event-1`, runId, revision: run.revision, type: run.status === 'completed' ? 'run.completed' : 'node.completed', payload: { nodeId: 'review' }, createdAt: run.updatedAt }], startGate: { status: 'started' }, nextEventCursor: run.revision };
}
function teamFixture(body, context) {
  if (body?.id !== 'team.runtime') return undefined;
  if (body.operationId === 'team.runList' && body.input?.teamId === teamId) return { teamId, runs: [activeRunId, previousRunId].map((runId) => ({ ...runRecord(runId, context), sessions: teamRoles(runId) })) };
  const runId = body.input?.runId;
  if (![activeRunId, previousRunId].includes(runId)) return undefined;
  if (body.operationId === 'team.runSnapshot') return teamSnapshot(runId, context);
  if (body.operationId === 'team.designSnapshot' && body.input?.teamId === teamId) return teamDesign(runId);
  if (body.operationId === 'team.runDiagnostics') return teamSnapshot(runId, context).diagnostics;
  return undefined;
}

export async function seedWorkflows(context = {}) {
  const { useTeamsStore } = await import('/src/plugins/teams/store.ts');
  const selectedRunId = context.scenarioId === 'teams-run-completed' ? previousRunId : activeRunId;
  const snapshot = teamSnapshot(selectedRunId, context);
  const runs = [activeRunId, previousRunId].map((runId) => ({ ...runRecord(runId, context), sessions: teamRoles(runId) }));
  const projections = { runByTeamId: snapshot.run, rolesByTeamId: snapshot.roles, graphByTeamId: snapshot.graph, workflowPlanByTeamId: snapshot.workflowPlan, stagesByTeamId: snapshot.stages, dispatchGroupsByTeamId: snapshot.dispatchGroups, dispatchTasksByTeamId: snapshot.dispatchTasks, approvalsByTeamId: snapshot.approvals, artifactsByTeamId: snapshot.artifacts, messagesByTeamId: snapshot.messages, nodeExecutionsByTeamId: snapshot.nodeExecutions, nodePromptDeliveryAttemptsByTeamId: snapshot.nodePromptDeliveries, dispatchesByTeamId: snapshot.dispatches, dispatchExecutionsByTeamId: snapshot.dispatchExecutions, gatesByTeamId: snapshot.gates, kickbacksByTeamId: snapshot.kickbacks, decisionsByTeamId: snapshot.decisions, eventsByTeamId: snapshot.events, startGateByTeamId: snapshot.startGate, eventCursorByTeamId: snapshot.nextEventCursor, loadingByTeamId: false, errorByTeamId: null };
  useTeamsStore.setState({ teams: [{ ...team, activeRunId: selectedRunId }], activeTeamId: teamId, runIdsByTeamId: { [teamId]: runs.map((run) => run.runId) }, runListByTeamId: { [teamId]: runs }, runsById: Object.fromEntries(runs.map(({ sessions, ...run }) => [run.runId, run])), ...Object.fromEntries(Object.entries(projections).map(([key, value]) => [key, { [teamId]: value }])), eventsByRunId: { [selectedRunId]: snapshot.events }, eventCursorByRunId: { [selectedRunId]: snapshot.nextEventCursor }, designByRunId: Object.fromEntries(runs.map((run) => [run.runId, { snapshot: teamDesign(run.runId), loading: false, mutationPending: false, error: null }])), manualTeamCreation: null });
}

const taskSource = 'src/plugins/tasks/pages/Tasks/index.tsx';
const cronSource = 'src/plugins/tasks/pages/Cron/index.tsx';
const agentSource = 'src/plugins/agents/pages/index.tsx';
const teamSource = 'src/plugins/teams/pages/index.tsx';
const graphSource = 'src/plugins/teams/pages/TeamChat.tsx';
const button = (name) => ({ role: 'button', name, exact: true });
const tab = (name) => ({ role: 'tab', name, exact: true });
const fill = (css, value) => ({ css, fill: value });
const cronEdit = (id) => ({ css: `[data-testid="cron-job-card-${id}"] button[aria-label="编辑"]` });
const agentEdit = button('编辑 researcher');
const createCron = [button('新建任务')];
const openCloud = async (page) => {
  await page.getByRole('button', { name: '更多操作 researcher', exact: true }).click();
  await page.getByRole('menuitem', { name: '云端包', exact: true }).click();
  await page.getByText('证据研究助手', { exact: true }).waitFor();
};

export const workflowsScenarios = [
  ...[['all', '全部'], ['running', '执行中'], ['waiting', '等待中'], ['completed', '已完成'], ['incomplete', '未完成']].map(([id, label]) => ({ id: `tasks-long-${id}`, title: `长任务 · ${label}`, group: '任务', route: '/tasks?tab=long', sources: [taskSource], actions: [button(label)], waitFor: id === 'completed' ? '完成现有流程与页面盘点' : id === 'waiting' ? '制定工作台改版方案' : '整理产品访谈与研究证据' })),
  { id: 'tasks-long-detail', title: '长任务 · 依赖与详情', group: '任务', route: '/tasks?tab=long', sources: [taskSource], prepare: async (page) => { await page.locator('[data-task-list-scroll="true"] button').filter({ hasText: '制定工作台改版方案' }).click(); }, waitFor: '覆盖任务列表、详情、空状态及异常恢复' },
  { id: 'tasks-long-delete', title: '长任务 · 删除确认', group: '任务', route: '/tasks?tab=long', sources: [taskSource], actions: [button('删除任务')], waitFor: '确认删除这个任务吗' },
  { id: 'tasks-long-custom-date', title: '长任务 · 自定义日期', group: '任务', route: '/tasks?tab=long', sources: [taskSource], actions: [{ css: 'select[aria-label="时间范围"]', select: 'custom' }], waitFor: '清除筛选' },
  ...[['all', '全部'], ['active', '启用'], ['running', '执行中'], ['paused', '暂停'], ['failed', '失败']].map(([id, label]) => ({ id: `tasks-scheduled-${id}`, title: `定时任务 · ${label}`, group: '任务', route: '/tasks?tab=scheduled', sources: [taskSource, cronSource], actions: [button(label)], waitFor: id === 'running' ? '研究资料定期整理' : id === 'paused' ? '每周复盘提醒' : id === 'failed' ? '团队进展推送' : '每日工作摘要' })),
  { id: 'tasks-scheduled-create-periodic', title: '定时任务 · 新建周期任务', group: '任务', route: '/tasks?tab=scheduled', sources: [cronSource], actions: [...createCron, fill('#name', '每周项目进展摘要'), fill('#message', '汇总本周完成事项、当前阻塞和下周重点，形成简洁的项目进展摘要。'), button('周期'), button('工作日上午 9 点')], waitFor: '创建任务' },
  { id: 'tasks-scheduled-create-once', title: '定时任务 · 新建单次任务', group: '任务', route: '/tasks?tab=scheduled', sources: [cronSource], actions: [...createCron, fill('#name', '交付前最终检查'), fill('#message', '检查交付清单与资料引用，整理待负责人确认的问题。'), button('单次'), fill('#once-date', new Date(now + 5 * day).toISOString().slice(0, 10)), fill('#once-time', '09:30')], waitFor: '创建任务' },
  { id: 'tasks-scheduled-create-delivery', title: '定时任务 · 新建外部推送', group: '任务', route: '/tasks?tab=scheduled', sources: [cronSource], actions: [...createCron, fill('#name', '团队协作群进展推送'), fill('#message', '整理项目进展、风险和需要协助的事项，发送到团队协作群。'), button('发送到外部通道'), { css: '#delivery-channel', select: 'feishu' }, fill('#delivery-target', 'oc_design_review')], waitFor: '发送到外部通道' },
  ...[['periodic', 'design-cron-daily', '周期任务'], ['once', 'design-cron-once', '单次任务'], ['delivery', 'design-cron-external', '外部推送']].map(([id, jobId, label]) => ({ id: `tasks-scheduled-edit-${id}`, title: `定时任务 · 编辑${label}`, group: '任务', route: '/tasks?tab=scheduled', sources: [cronSource], actions: [cronEdit(jobId)], waitFor: '编辑任务' })),
  { id: 'tasks-scheduled-delete', title: '定时任务 · 删除确认', group: '任务', route: '/tasks?tab=scheduled', sources: [cronSource], actions: [{ css: '[data-testid="cron-job-card-design-cron-daily"] button[aria-label="删除"]' }], waitFor: '确定要删除此任务吗？' },
  { id: 'subagents-grid', title: '我的 Agent · 网格', group: '智能体', route: '/subagents?tab=agents&view=grid', sources: [agentSource], waitFor: '研究助手' },
  { id: 'subagents-list', title: '我的 Agent · 列表', group: '智能体', route: '/subagents?tab=agents&view=list', sources: [agentSource], waitFor: '研究助手' },
  { id: 'subagents-create', title: 'Agent · 新建', group: '智能体', route: '/subagents?tab=agents', sources: [agentSource, 'src/plugins/agents/pages/components/SubagentFormDialog.tsx'], actions: [button('新增 Agent'), fill('#subagent-name', 'design-writer'), fill('#subagent-description', '整理产品叙事与交付文案，确保表达清晰、结构一致。')], waitFor: '新增Agent' },
  ...[['basic', '基本信息'], ['persona', '人设'], ['skills', '技能'], ['tools', 'Tool']].map(([id, label]) => ({ id: `subagents-edit-${id}`, title: `Agent · 编辑${label}`, group: '智能体', route: '/subagents?tab=agents', sources: [agentSource, 'src/plugins/agents/pages/components/SubagentFormDialog.tsx'], actions: [agentEdit, tab(label)], waitFor: id === 'persona' ? '研究助手工作约定' : id === 'skills' ? '公开资料研究' : id === 'tools' ? '工具 Profile' : '编辑子Agent' })),
  { id: 'subagents-persona-soul', title: 'Agent · 人设文件', group: '智能体', route: '/subagents?tab=agents', sources: ['src/plugins/agents/pages/components/SubagentFilesPreview.tsx', agentSource], actions: [agentEdit, tab('人设'), button('SOUL.md')], waitFor: '严谨而不生硬' },
  { id: 'subagents-delete', title: 'Agent · 删除确认', group: '智能体', route: '/subagents?tab=agents', sources: ['src/plugins/agents/pages/components/SubagentDeleteDialog.tsx', agentSource], prepare: async (page) => { await page.getByRole('button', { name: '更多操作 researcher', exact: true }).click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click(); }, waitFor: '删除 researcher' },
  { id: 'subagents-templates-grid', title: '模板库 · 网格', group: '智能体', route: '/subagents?tab=templates&templateView=grid', sources: ['src/plugins/agents/pages/components/SubagentTemplateLibrary.tsx', agentSource], waitFor: '研究分析助手' },
  { id: 'subagents-templates-list', title: '模板库 · 列表', group: '智能体', route: '/subagents?tab=templates&templateView=list', sources: ['src/plugins/agents/pages/components/SubagentTemplateLibrary.tsx', agentSource], waitFor: '研究分析助手' },
  { id: 'subagents-template-load', title: '模板库 · 加载模板', group: '智能体', route: '/subagents?tab=templates', sources: ['src/plugins/agents/pages/components/SubagentTemplateLoadDialog.tsx', agentSource], actions: [{ ...button('查看模板'), index: 0 }], waitFor: '加载模板：研究分析助手' },
  { id: 'subagents-cloud-mine', title: 'Agent 云端包 · 我的包', group: '智能体', route: '/subagents?tab=agents', sources: [agentSource], prepare: openCloud, waitFor: '我的云端包' },
  { id: 'subagents-cloud-market', title: 'Agent 云端包 · 资源包市场', group: '智能体', route: '/subagents?tab=agents', sources: [agentSource], prepare: async (page) => { await openCloud(page); await page.getByText('资源包市场', { exact: true }).scrollIntoViewIfNeeded(); }, waitFor: '交付评审助手' },
  { id: 'teams-list', title: '团队 · 团队列表', group: '团队', route: '/teams', sources: [teamSource], waitFor: team.name },
  { id: 'teams-create-teamskill', title: '团队 · 从 TeamSkill 创建', group: '团队', route: '/teams', sources: [teamSource], actions: [button('创建团队'), tab('加载 TeamSkill'), fill('#team-name', '体验研究协作组')], waitFor: '选择 TeamSkill 包' },
  { id: 'teams-create-manual', title: '团队 · 选择队员创建', group: '团队', route: '/teams', sources: [teamSource, 'src/plugins/teams/pages/TeamMemberPicker.tsx'], prepare: async (page) => { await page.getByRole('button', { name: '创建团队', exact: true }).click(); await page.getByRole('tab', { name: '选择队员', exact: true }).click(); await page.locator('#team-name').fill('体验研究协作组'); await page.getByRole('checkbox', { name: '选择 主助手', exact: true }).click(); await page.getByRole('checkbox', { name: '选择 研究助手', exact: true }).click(); }, waitFor: '团队成员' },
  { id: 'teams-workflow', title: '团队运行 · 工作流画布', group: '团队', route: `/teams/${teamId}`, sources: [graphSource, 'src/plugins/teams/pages/TeamRunGraphCanvas.tsx'], prepare: async (page) => { await page.locator('[data-node-id="research"]').waitFor({ state: 'visible' }); }, waitFor: '资料研究' },
  { id: 'teams-run-history', title: '团队运行 · 运行记录', group: '团队', route: `/teams/${teamId}`, sources: [graphSource], prepare: async (page) => { await page.getByRole('combobox', { name: '运行记录', exact: true }).click(); }, waitFor: 'design00' },
  { id: 'teams-run-completed', title: '团队运行 · 已完成运行', group: '团队', route: `/teams/${teamId}`, sources: [graphSource, 'src/plugins/teams/pages/TeamRunGraphCanvas.tsx'], prepare: async (page) => { await page.locator('[data-node-id="end"]').waitFor({ state: 'visible' }); }, waitFor: '已完成' },
  { id: 'teams-approval', title: '团队运行 · 人工审批', group: '团队', route: `/teams/${teamId}`, sources: [graphSource], waitFor: '确认研究摘要与证据索引，可以向合成项目协作群交付。' },
  ...[['start', '触发入口', '触发方式'], ['research', '工作节点', '任务指令'], ['review', '审核节点', '审核要求'], ['approval', '人工决策节点', '交付方案确认'], ['quality', '规则检查节点', '检查规则'], ['join', '汇合节点', '汇合研究与确认结果'], ['end', '结束节点', '交付研究结论']].map(([nodeId, label, waitFor]) => ({ id: `teams-node-${nodeId}`, title: `工作流 · ${label}配置`, group: '团队', route: `/teams/${teamId}`, sources: ['src/plugins/teams/pages/TeamNodeInspector.tsx', 'src/plugins/teams/pages/TeamRunGraphCanvas.tsx', graphSource], actions: [{ css: `[data-node-id="${nodeId}"]` }], waitFor })),
  { id: 'teams-edge-inspector', title: '工作流 · 连线配置', group: '团队', route: `/teams/${teamId}`, sources: ['src/plugins/teams/pages/TeamEdgeInspector.tsx', 'src/plugins/teams/pages/TeamRunGraphCanvas.tsx', graphSource], prepare: async (page) => { await page.locator('[data-team-graph-canvas="true"]:not([inert])').waitFor({ state: 'visible' }); const edge = page.getByRole('button', { name: '资料研究 → 方案审核: completed', exact: true }); await edge.waitFor({ state: 'attached' }); const point = await edge.evaluate((path) => { const midpoint = path.getPointAtLength(path.getTotalLength() / 2); const screen = midpoint.matrixTransform(path.getScreenCTM()); return { x: screen.x, y: screen.y }; }); await page.mouse.move(point.x, point.y); await edge.locator('..').locator('foreignObject button').click(); await page.getByRole('dialog', { name: '连线配置', exact: true }).waitFor(); }, waitFor: '将上游结果传给下游' },
];
