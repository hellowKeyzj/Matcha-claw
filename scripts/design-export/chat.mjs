const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
const identity = { endpoint, agentId: 'main', sessionKey: 'agent:main:design-export' };
const notesIdentity = { endpoint, agentId: 'main', sessionKey: 'agent:main:design-notes' };
const workspace = 'C:/MatchaDesign/workspace';
const at = Date.UTC(2026, 9, 22, 8);
const model = { provider: 'demo-openai', model: 'gpt-5.5', ref: 'demo-openai/gpt-5.5' };
const modelState = { selected: model, active: model, overrideSource: 'user', selectionId: 'model:design-01' };
const readme = '# 项目工作台\n\n把想法变成清晰、可执行的交付。\n\n## 设计目标\n\n- 让重要信息一眼可见\n- 保持聊天与产物之间的上下文\n- 用原生看板追踪关键进度\n\n## 下一步\n\n完成视觉评审，并整理交付说明。\n';
const summary = 'export const project = {\n  name: "项目工作台",\n  status: "ready-for-review",\n  milestones: 3,\n};\n';
const files = { 'README.md': readme, 'src/summary.ts': summary, 'notes/review.md': '# 评审记录\n\n信息层级已确认，等待视觉评审。\n' };

function requestIdentity(body) {
  return body.input?.sessionIdentity ?? body.input?.identity ?? body.scope?.identity ?? body.target?.identity ?? identity;
}

function sessionView(context, target = identity) {
  const empty = context.scenarioId.startsWith('chat-empty');
  const streaming = context.scenarioId === 'chat-streaming';
  const approval = context.scenarioId === 'chat-approval';
  const withTools = /artifacts|workspace|tools|streaming|approval/.test(context.scenarioId);
  const goal = context.scenarioId.startsWith('chat-goal') && context.scenarioId !== 'chat-goal-create' ? {
    schemaVersion: 1, id: 'design-goal', objective: '完成项目工作台设计交付', status: 'active', createdAt: at, updatedAt: at,
    tokenStart: 0, tokenStartFresh: true, tokensUsed: 12580, tokenBudget: 60000, continuationTurns: 2,
    lastStatusNote: '信息架构与页面说明已完成，等待视觉评审。',
  } : null;
  const text = streaming
    ? '正在整理交付清单，并核对每个页面的信息层级。\n\n### 已完成\n\n- 梳理目标用户与主要任务\n- 汇总工作区中的设计说明\n\n接下来我会'
    : '## 工作台方案已整理\n\n建议将体验分为 **对话、产物、进度** 三个层次：\n\n| 区域 | 作用 |\n| --- | --- |\n| 对话 | 保留决策与执行上下文 |\n| 产物 | 浏览文件、预览内容与变更 |\n| 看板 | 持续关注里程碑和交付状态 |\n\n### 交付建议\n\n1. 先确认信息层级和关键操作。\n2. 再逐页检查空态、执行中与待确认状态。\n3. 最后统一视觉语言和交付说明。\n\n所有示例内容均为合成设计数据。';
  const tools = withTools ? [
    { toolCallId: 'tool-write', runId: 'design-run', name: 'write', phase: 'completed', input: { path: `${workspace}/README.md`, content: readme }, inputText: null, summary: '已创建 README.md', output: 'Successfully wrote README.md', details: null, isError: false },
    { toolCallId: 'tool-edit', runId: 'design-run', name: 'edit', phase: 'completed', input: { path: `${workspace}/src/summary.ts`, old_string: 'status: "draft"', new_string: 'status: "ready-for-review"' }, inputText: null, summary: '已更新项目交付状态', output: 'Successfully edited src/summary.ts', details: null, isError: false },
    ...(streaming || approval ? [{ toolCallId: 'tool-exec', runId: 'design-run', name: 'exec', phase: 'started', input: { command: 'git diff --stat' }, inputText: null, summary: null, output: null, details: null, isError: null }] : []),
  ] : [];
  const items = empty ? [] : [
    { kind: 'userMessage', itemId: 'design-user', messageId: 'design-user-message', text: '请帮我整理项目工作台的设计方案，并列出下一步交付建议。', content: [{ kind: 'text', text: '请帮我整理项目工作台的设计方案，并列出下一步交付建议。' }], status: 'final' },
    { kind: 'assistantTurn', itemId: 'design-assistant', runId: 'design-run', messageId: 'design-assistant-message', status: approval ? 'waiting_for_tool' : streaming ? 'streaming' : 'final', segments: [
      ...(streaming ? [{ kind: 'thinking', text: '先核对工作区与交付目标，再把建议组织成可执行的清单。' }] : []),
      ...tools.flatMap((tool) => [{ kind: 'toolUse', name: tool.name, toolCallId: tool.toolCallId }, ...(tool.phase === 'completed' ? [{ kind: 'toolResult', toolCallId: tool.toolCallId, summary: tool.summary, isError: false }] : [])]),
      { kind: 'text', text },
    ], text },
  ];
  return {
    sessionKey: target.sessionKey, endpointSessionId: target.sessionKey.endsWith('design-notes') ? 'design-notes-runtime' : 'design-runtime',
    modelState, goal: { kind: 'known', goal }, ownership: { kind: 'ordinary' }, identity: target, epoch: 1, seq: 12, cursor: 12,
    items: { complete: items }, tools: { complete: tools },
    approvals: { complete: approval ? [{ approvalId: 'design-approval', runId: 'design-run', phase: 'requested', optionIds: ['allow-once', 'allow-always', 'deny'] }] : [] },
    runtime: { complete: { phase: approval ? 'waiting_for_approval' : streaming ? 'started' : 'completed', activeRunId: streaming || approval ? 'design-run' : null, issue: null, runProgress: null, runtimeActivity: null, errorDetail: null } },
    window: { complete: { totalItemCount: items.length, windowStartOffset: 0, windowEndOffset: items.length, hasMore: false, hasNewer: false, isAtLatest: true } }, completeness: 'complete',
  };
}

function catalog(context) {
  const automation = ['chat-sessions', 'chat-sessions-automation'].includes(context.scenarioId);
  return [identity, notesIdentity].map((sessionIdentity, index) => ({
    key: sessionIdentity.sessionKey, agentId: 'main', protocolId: 'openclaw', runtimeEndpointId: 'openclaw:local',
    endpointSessionId: index ? 'design-notes-runtime' : 'design-runtime', sessionIdentity, ownership: { kind: 'ordinary' },
    kind: automation && index ? 'automation' : 'session', preferred: false, status: 'active', label: index ? '设计评审记录' : '项目工作台设计', titleSource: 'user',
    displayName: index ? '设计评审记录' : '项目工作台设计', modelState,
    contextTokens: { totalTokens: 12580, totalTokensFresh: true, contextTokens: 1048576 }, updatedAt: at - index * 3600000,
  }));
}

function boardSnapshot(target) {
  const widget = (name, tabId, title, pluginKind, props, sizeH) => ({ name, tabId, title, contentKind: 'plugin', contentOwner: 'plugin', pluginKind, props, presentation: 'frameless', heightMode: 'fixed', sizeW: 12, sizeH, position: 0, grantState: 'none', revision: 1, instanceId: `design-${name}` });
  return {
    sessionKey: target.sessionKey, revision: 3,
    tabs: [{ tabId: 'overview', title: '项目总览', position: 0, chatDock: 'left' }, { tabId: 'progress', title: '交付进度', position: 1, chatDock: 'left' }],
    widgets: [
      widget('project-report', 'overview', '工作台设计简报', 'session:report', { blocks: [
        { type: 'text', title: '让协作有清晰的落点', text: '将对话中的方案、文件与关键进展集中在一个工作空间。' },
        { type: 'metrics', items: [{ label: '里程碑', value: '3', detail: '目标与交付范围已确认' }, { label: '完成度', value: '67%', detail: '进入视觉评审阶段' }] },
        { type: 'table', title: '交付清单', columns: ['内容', '状态'], rows: [['信息架构', '已完成'], ['页面说明', '已完成'], ['视觉评审', '进行中']] },
      ] }, 12),
      widget('project-progress', 'progress', '交付进度追踪', 'session:progress', { sessionKey: target.sessionKey }, 11),
    ],
  };
}

function workspaceFixture(operationId, input) {
  const relativePath = (input.relativePath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const content = files[relativePath];
  if (operationId === 'files.listDir') {
    const entries = relativePath === 'src' ? [{ relativePath: 'src/summary.ts', display: 'summary.ts', isDirectory: false, size: summary.length }]
      : relativePath === 'notes' ? [{ relativePath: 'notes/review.md', display: 'review.md', isDirectory: false, size: files['notes/review.md'].length }]
        : [{ relativePath: 'README.md', display: 'README.md', isDirectory: false, size: readme.length }, { relativePath: 'src', display: 'src', isDirectory: true, size: 0 }, { relativePath: 'notes', display: 'notes', isDirectory: true, size: 0 }];
    return { entries };
  }
  if (content === undefined) return undefined;
  const name = relativePath.split('/').at(-1);
  const size = new TextEncoder().encode(content).length;
  if (operationId === 'files.readText') return { name, content, size };
  if (operationId === 'files.stat') return { name, isDirectory: false, size, mtimeMs: at };
  return undefined;
}

export function chatFixture(path, body = {}, context) {
  if (path === '/api/openclaw/workspace-dir') return workspace;
  if (path === '/api/openclaw/task-workspace-dirs') return [workspace];
  if (['/api/files/read-text', '/api/files/list-dir', '/api/files/binary'].includes(path) && body.id === 'workspace.file') return workspaceFixture(body.operationId, body.input);
  if (path === '/api/board/execute' && body.operation?.method === 'board.get') return boardSnapshot(body.identity);
  if (path !== '/api/capabilities/execute') return undefined;
  const { id, operationId, input = {} } = body;
  const target = requestIdentity(body);
  if (id === 'workspace.file') return workspaceFixture(operationId, input);
  if (id === 'session.management') {
    if (operationId === 'sessions.list') {
      const requestEndpoint = input.endpoint ?? body.scope?.endpoint;
      return { sessions: requestEndpoint?.runtimeAdapterId === 'openclaw' ? catalog(context) : [], ready: true, refreshing: false, updatedAt: at, error: null };
    }
    if (operationId === 'sessions.observe') return { leaseId: input.leaseId, view: sessionView(context, target) };
    if (operationId === 'sessions.release') return { outcome: 'released' };
    if (['sessions.window', 'sessions.switch', 'sessions.resume', 'sessions.state'].includes(operationId)) return sessionView(context, target);
    if (operationId === 'sessions.permission.get' || operationId === 'sessions.permission.set') return target.endpoint.runtimeAdapterId === 'openclaw'
      ? { supported: true, mode: operationId.endsWith('.set') ? input.permissionMode : 'guarded', defaultMode: 'guarded', pending: false, canSelectFull: true, options: ['read-only', 'guarded', 'workspace', 'full'], ...(operationId.endsWith('.set') ? { changed: true } : {}) }
      : { runtime: 'matcha-agent', mode: input.permissionMode ?? null, ...(operationId.endsWith('.set') ? { persisted: true, applied: true } : {}) };
  }
  if (id === 'session.prompt' && operationId === 'sessions.load') return sessionView(context, target);
  if (id === 'session.approval' && operationId === 'approvals.list') return { approvals: context.scenarioId === 'chat-approval' ? [{
    id: 'design-approval', sessionKey: target.sessionKey, sessionIdentity: target, runId: 'design-run', title: '查看项目变更摘要', command: 'git diff --stat',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'], request: { command: 'git diff --stat', cwd: workspace }, createdAtMs: at, expiresAtMs: Date.UTC(2035, 0, 1),
  }] : [] };
  if (id === 'session.modelSelection' && operationId === 'sessions.patchModel') return { outcome: 'succeeded', modelState: { ...modelState, selectionId: input.modelSelectionId } };
  if (id === 'openclaw.question' && operationId === 'question.list') return { questions: context.scenarioId.startsWith('chat-question') ? [{
    id: 'design-question', agentId: target.agentId, sessionKey: target.sessionKey, runId: 'design-run', createdAtMs: at, expiresAtMs: Date.UTC(2035, 0, 1), status: 'pending',
    questions: [{ questionId: 'design_direction', header: '设计方向', question: '这次交付优先关注哪个方向？', options: [{ label: '信息层级', description: '先让结构与主要操作更清晰' }, { label: '视觉表达', description: '先统一色彩、间距和组件语言' }], multiSelect: false, isOther: true }, { questionId: 'delivery_scope', header: '交付范围', question: '需要同时整理哪些交付内容？', options: [{ label: '页面说明', description: '整理主要页面和关键状态' }, { label: '组件清单', description: '列出可复用的视觉组件' }], multiSelect: true, isOther: true }],
  }] : [] };
  if (id === 'session.question' && operationId === 'sessions.questions.list') return { outcome: 'listed', questions: [] };
  if (id === 'openclaw.progress' && operationId === 'progressCard.get') return { sessionIdentity: target, card: { sessionKey: target.sessionKey, revision: 2, updatedAt: at, markdown: '### 设计交付\n\n信息架构与页面说明已完成，正在等待视觉评审。', steps: [{ step: '梳理信息架构', status: 'completed' }, { step: '整理页面说明', status: 'completed' }, { step: '完成视觉评审', status: 'in_progress' }, { step: '提交最终交付包', status: 'pending' }] } };
  return undefined;
}

export async function seedChat(context) {
  if (!context.scenarioId.startsWith('chat-')) return;
  localStorage.setItem('chat:side-panel-tab', 'artifacts');
  localStorage.setItem('chat:side-panel-width', '680');
  if (context.scenarioId.startsWith('chat-quick-phrases')) localStorage.setItem('matchaclaw:chat:quick-phrases', JSON.stringify([
    { id: 'design-phrase-summary', text: '请整理当前结论、待决问题与下一步行动。' },
    { id: 'design-phrase-review', text: '请按目标、风险和验收标准检查这份方案。' },
  ]));
  const { useChatStore } = await import('/src/plugins/chat/store.ts');
  await useChatStore.getState().bootstrapSessionRuntime();
  await useChatStore.getState().loadSessions();
  useChatStore.getState().openSessionIdentity({ sessionIdentity: identity, endpointSessionId: 'design-runtime' });
  await useChatStore.getState().loadHistory({ sessionKey: useChatStore.getState().currentSessionKey, mode: 'active', scope: 'foreground', reason: 'design-export' });
  if (context.scenarioId === 'chat-empty-draft') await useChatStore.getState().newSession('main');
  if (context.scenarioId === 'chat-approval') await useChatStore.getState().syncPendingApprovals();
}

const chatSources = ['src/plugins/chat/index.tsx', 'src/plugins/chat/store/store.ts', 'src/lib/host-api.ts'];
const button = (name) => ({ role: 'button', name, exact: true });
const css = (selector) => ({ css: selector });
const panel = (tab) => [button('打开右侧栏'), css(`[data-testid="chat-side-panel-tab-${tab}"]`)];
const switchboard = (name) => [css('[data-testid="agent-session-identity-beacon"]'), css(`[data-testid="chat-switchboard"] button:text-is("${name}")`)];
const workspaceActions = [...panel('artifacts'), css('[data-testid="chat-artifact-section-workspace"]')];
const fileActions = [...workspaceActions, css('[data-testid="workspace-tree-node"][data-path$="README.md"]')];
const boardActions = panel('board');
function scene(id, title, actions = [], source, waitFor) {
  return { id: `chat-${id}`, title, group: '聊天', route: '/', sources: [...chatSources, ...(source ? [source] : [])], actions, ...(waitFor ? { waitFor } : {}) };
}

export const chatScenarios = [
  scene('empty', '聊天 · 空会话'),
  scene('empty-draft', '聊天 · 新对话空态'),
  scene('conversation', '聊天 · 完整会话', [], 'src/plugins/chat/ChatMessages.tsx', '工作台方案已整理'),
  scene('streaming', '聊天 · 流式输出与思考', [], 'src/plugins/message-rendering/ChatAssistantTurn.tsx', '正在整理交付清单'),
  scene('tools', '聊天 · 工具调用与文件产物', [], 'src/plugins/message-rendering/ExecutionGraphCard.tsx', '工作台方案已整理'),
  { ...scene('tools-expanded', '聊天 · 工具调用列表', [], 'src/plugins/message-rendering/chat-message-parts.tsx'), prepare: async (page) => {
    await page.locator('[data-compact-rail="tool-group"] > button').first().click();
  } },
  { ...scene('tools-details', '聊天 · 工具调用详情', [], 'src/plugins/message-rendering/chat-message-parts.tsx'), prepare: async (page) => {
    await page.locator('[data-compact-rail="tool-group"] > button').first().click();
    await page.locator('[data-compact-rail="tool"] button[data-chat-local-geometry-anchor="true"]').first().click();
  } },
  scene('approval', '聊天 · 待审批命令', [], 'src/plugins/chat/ChatComposer.tsx', '同意一次'),
  scene('question', '聊天 · 单选问题', [], 'src/plugins/chat/components/ChatQuestionDock.tsx', '这次交付优先关注哪个方向'),
  { ...scene('question-multiple', '聊天 · 多选问题', [], 'src/plugins/chat/components/ChatQuestionDock.tsx', '需要同时整理哪些交付内容'), prepare: async (page) => {
    await page.getByText('这次交付优先关注哪个方向', { exact: false }).waitFor();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
  } },
  scene('agents', '聊天 · Agent 快速切换', switchboard('Agent'), 'src/plugins/chat/AgentSessionsPane.tsx'),
  scene('teams', '聊天 · 团队快速切换', switchboard('团队'), 'src/plugins/chat/AgentSessionsPane.tsx'),
  scene('sessions', '聊天 · 普通会话列表', [...switchboard('会话'), css('[data-testid="chat-switchboard"] [role="tab"][aria-label^="普通 "]')], 'src/plugins/chat/AgentSessionsPane.tsx', '项目工作台设计'),
  scene('sessions-automation', '聊天 · 自动化会话列表', [...switchboard('会话'), css('[data-testid="chat-switchboard"] [role="tab"][aria-label^="自动化 "]')], 'src/plugins/chat/AgentSessionsPane.tsx', '设计评审记录'),
  scene('session-rename', '聊天 · 重命名会话', [...switchboard('会话'), button('重命名会话 设计评审记录')], 'src/plugins/chat/AgentSessionsPane.tsx'),
  scene('session-delete', '聊天 · 删除会话确认', [...switchboard('会话'), button('删除会话 设计评审记录')], 'src/plugins/chat/AgentSessionsPane.tsx', '确认删除'),
  scene('models', '聊天 · 模型选择', [css('[data-testid="chat-model-picker"]')], 'src/plugins/chat/ChatInput.tsx'),
  scene('permissions', '聊天 · 权限模式选择', [css('[data-testid="chat-permission-picker"]')], 'src/plugins/chat/ChatInput.tsx'),
  scene('skills', '聊天 · 技能配置', [css('[data-testid="chat-skill-manager-button"]')], 'src/plugins/chat/components/AgentSkillManagerDialog.tsx', '团队工作手册'),
  { ...scene('skill-readme', '聊天 · 技能手册预览', [], 'src/plugins/chat/components/AgentSkillManagerDialog.tsx', '协作约定'), prepare: async (page) => {
    const input = page.getByTestId('chat-composer').locator('textarea').first();
    await input.fill('/team-handbook');
    await page.getByRole('option').filter({ hasText: '/team-handbook' }).click();
    await page.getByTestId('chat-selected-skill-preview').click();
    await page.getByTestId('chat-skill-preview-panel').waitFor();
  } },
  scene('quick-phrases', '聊天 · 快捷短语', [css('button[aria-label="快捷短语"]')], 'src/plugins/chat/ChatInput.tsx', '快捷短语列表'),
  scene('quick-phrases-add', '聊天 · 新增快捷短语', [css('button[aria-label="快捷短语"]'), button('新增短语'), { css: '#quick-phrase-draft', fill: '请将本轮讨论整理成可以直接执行的交付清单。' }], 'src/plugins/chat/ChatInput.tsx', '新增快捷短语'),
  scene('goal', '聊天 · 会话目标', [], 'src/plugins/chat/ChatGoalDock.tsx', '完成项目工作台设计交付'),
  scene('goal-details', '聊天 · 目标进度详情', [css('section[aria-label="会话目标"] button[aria-controls][aria-expanded]')], 'src/plugins/chat/ChatGoalDock.tsx', '预算'),
  scene('goal-menu', '聊天 · 目标操作菜单', [button('更多目标操作')], 'src/plugins/chat/ChatGoalDock.tsx', '标记完成'),
  scene('goal-edit', '聊天 · 编辑目标', [button('编辑目标')], 'src/plugins/chat/ChatInput.tsx'),
  scene('goal-create', '聊天 · 设定目标', [css('[data-chat-control="goal"]')], 'src/plugins/chat/ChatInput.tsx'),
  { ...scene('todos', '聊天 · 会话任务清单', [css('[data-testid="session-todo-panel"] > button')], 'src/plugins/chat/components/SessionTodoPanel.tsx', '提交最终交付包'), prepare: async (page) => {
    await page.evaluate(async () => {
      const { useChatStore } = await import('/src/plugins/chat/store.ts');
      const { useTaskCenterStore } = await import('/src/plugins/tasks/stores/task-center-store.ts');
      const { useTaskSnapshotStore } = await import('/src/plugins/chat/store/task-snapshot-store.ts');
      const state = useChatStore.getState();
      const sessionIdentity = state.loadedSessions[state.currentSessionKey].meta.sessionIdentity;
      await useTaskCenterStore.getState().refreshTasks({ sessionKey: state.currentSessionKey, sessionIdentity, background: true });
      useTaskSnapshotStore.getState().reportTodos(state.currentSessionKey, [
        { id: 'design-todo-1', content: '梳理信息架构', status: 'completed' },
        { id: 'design-todo-2', content: '整理页面说明', status: 'completed' },
        { id: 'design-todo-3', content: '完成视觉评审', activeForm: '正在进行视觉评审', status: 'in_progress' },
        { id: 'design-todo-4', content: '提交最终交付包', status: 'pending' },
      ]);
    });
  } },
  scene('artifacts-changes', '聊天 · 产物变更', [...fileActions, css('[data-testid="chat-artifact-section-changes"]')], 'src/plugins/chat/components/ChatSidePanel.tsx'),
  scene('artifacts-preview', '聊天 · 产物预览', [...fileActions, css('[data-testid="chat-artifact-section-preview"]')], 'src/plugins/files/FilePreviewBody.tsx', '设计目标'),
  scene('workspace', '聊天 · 工作区文件树', workspaceActions, 'src/plugins/files/WorkspaceBrowserBody.tsx', 'README.md'),
  scene('workspace-file', '聊天 · 工作区文件预览', fileActions, 'src/plugins/files/WorkspaceBrowserBody.tsx', '设计目标'),
  scene('artifacts-fullscreen', '聊天 · 产物全屏工作台', [...fileActions, css('[data-testid="chat-side-panel-artifact-fullscreen-toggle"]')], 'src/plugins/chat/components/ChatSidePanel.tsx', '设计目标'),
  scene('runtime', '聊天 · 运行视图', panel('runtime'), 'src/plugins/chat/components/ChatRuntimeSurfacePanel.tsx', '从工具卡片打开'),
  scene('board-overview', '聊天 · 看板项目总览', boardActions, 'src/plugins/surfaces/board/BoardPanel.tsx', '让协作有清晰的落点'),
  scene('board-progress', '聊天 · 看板交付进度', [...boardActions, css('[data-board-tab-id="progress"]')], 'src/plugins/surfaces/BoardProgressContent.tsx', '交付进度追踪'),
  scene('board-fullscreen', '聊天 · 看板全屏', [...boardActions, button('全屏查看看板')], 'src/plugins/surfaces/board/BoardPanel.tsx', '让协作有清晰的落点'),
  scene('board-tab-create', '聊天 · 创建看板标签页', [...boardActions, button('创建标签页')], 'src/plugins/surfaces/board/BoardPanel.tsx', '标签页名称'),
  { ...scene('board-tab-rename', '聊天 · 重命名看板标签页', [], 'src/plugins/surfaces/board/BoardPanel.tsx', '标签页名称'), prepare: async (page) => {
    await page.getByRole('button', { name: '打开右侧栏', exact: true }).click();
    await page.getByTestId('chat-side-panel-tab-board').click();
    await page.getByRole('button', { name: '标签页菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '重命名标签页', exact: true }).click();
  } },
  { ...scene('board-tab-delete', '聊天 · 删除看板标签页确认', [], 'src/plugins/surfaces/board/BoardPanel.tsx'), prepare: async (page) => {
    await page.getByRole('button', { name: '打开右侧栏', exact: true }).click();
    await page.getByTestId('chat-side-panel-tab-board').click();
    await page.getByRole('button', { name: '标签页菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除标签页', exact: true }).click();
  } },
  scene('board-widget-add', '聊天 · 固定看板小组件', [...boardActions, button('固定小组件')], 'src/plugins/surfaces/board/BoardWidgetEditor.tsx'),
  { ...scene('board-widget-edit', '聊天 · 替换小组件内容', [], 'src/plugins/surfaces/board/BoardWidgetEditor.tsx'), prepare: async (page) => {
    await page.getByRole('button', { name: '打开右侧栏', exact: true }).click();
    await page.getByTestId('chat-side-panel-tab-board').click();
    await page.locator('[data-board-widget="project-report"] button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '替换内容', exact: true }).click();
  } },
  { ...scene('board-widget-remove', '聊天 · 移除看板小组件确认', [], 'src/plugins/surfaces/board/BoardPanel.tsx', '从看板移除此小组件'), prepare: async (page) => {
    await page.getByRole('button', { name: '打开右侧栏', exact: true }).click();
    await page.getByTestId('chat-side-panel-tab-board').click();
    await page.locator('[data-board-widget="project-report"] button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '移除小组件', exact: true }).click();
  } },
];
