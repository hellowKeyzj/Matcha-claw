const teamWorkflowScenes = ['teams-workflow', 'teams-run-history', 'teams-approval', 'teams-node-', 'teams-edge-inspector'];

export const navigationRules = [
  ...[['长任务', 'tasks-long-all'], ['定时任务', 'tasks-scheduled-all']].map(([text, target]) => ({
    from: 'tasks-', selector: 'main [role="tablist"] > button[role="tab"]', text, target,
  })),
  ...[['全部', 'all'], ['执行中', 'running'], ['等待中', 'waiting'], ['已完成', 'completed'], ['未完成', 'incomplete']].map(([label, status]) => ({
    from: 'tasks-long-', selector: `main [role="tabpanel"][id$="-content-long"] button[aria-label="${label}"][aria-pressed]`, target: `tasks-long-${status}`,
  })),
  {
    from: 'tasks-long-', selector: 'main [role="tabpanel"][id$="-content-long"] button[aria-pressed="true"]:is([aria-label="执行中"], [aria-label="等待中"], [aria-label="已完成"], [aria-label="未完成"])', target: 'tasks-long-all',
  },
  { from: 'tasks-long-', selector: 'main [role="tabpanel"][id$="-content-long"] button', text: '清除筛选', target: 'tasks-long-all' },
  { from: 'tasks-long-detail', selector: 'main [data-task-list-scroll="true"] button', text: '整理产品访谈与研究证据研究助手0 blockers', target: 'tasks-long-all' },
  { from: 'tasks-long-', selector: 'main [data-task-list-scroll="true"] button', text: '制定工作台改版方案主助手1 blockers', target: 'tasks-long-detail' },
  {
    from: ['tasks-long-all', 'tasks-long-running', 'tasks-long-incomplete', 'tasks-long-custom-date'],
    selector: 'main [role="tabpanel"][id$="-content-long"] button', text: '删除任务', target: 'tasks-long-delete',
  },
  { from: 'tasks-long-delete', selector: '[role="dialog"][aria-labelledby="confirm-dialog-title"] button', text: '取消', target: 'tasks-long-all' },
  ...[['全部', 'all'], ['启用', 'active'], ['执行中', 'running'], ['暂停', 'paused'], ['失败', 'failed']].map(([label, status]) => ({
    from: 'tasks-scheduled-', selector: `main [role="tabpanel"][id$="-content-scheduled"] button[aria-label="${label}"][aria-pressed]`, target: `tasks-scheduled-${status}`,
  })),
  { from: 'tasks-scheduled-', selector: 'main [role="tabpanel"][id$="-content-scheduled"] button', text: '新建任务', target: 'tasks-scheduled-create-periodic' },
  ...[['daily', 'periodic'], ['once', 'once'], ['external', 'delivery']].map(([job, form]) => ({
    from: 'tasks-scheduled-', selector: `main [data-testid="cron-job-card-design-cron-${job}"] button[aria-label="编辑"]`, target: `tasks-scheduled-edit-${form}`,
  })),
  { from: 'tasks-scheduled-', selector: 'main [data-testid="cron-job-card-design-cron-daily"] button[aria-label="删除"]', target: 'tasks-scheduled-delete' },
  ...[['周期', 'periodic'], ['单次', 'once']].map(([text, form]) => ({
    from: ['tasks-scheduled-create-periodic', 'tasks-scheduled-create-once'], selector: '[role="dialog"][aria-labelledby="cron-task-dialog-title"] button', text, target: `tasks-scheduled-create-${form}`,
  })),
  { from: 'tasks-scheduled-create-periodic', selector: '[role="dialog"][aria-labelledby="cron-task-dialog-title"] button', text: '发送到外部通道', target: 'tasks-scheduled-create-delivery' },
  { from: 'tasks-scheduled-create-delivery', selector: '[role="dialog"][aria-labelledby="cron-task-dialog-title"] button', text: '仅在 MatchaClaw 内', target: 'tasks-scheduled-create-periodic' },
  // 编辑场景分别属于三个任务，不把切换表单模式映射成更换编辑对象。
  { from: ['tasks-scheduled-create-', 'tasks-scheduled-edit-'], selector: '[role="dialog"][aria-labelledby="cron-task-dialog-title"] button[aria-label="关闭"]', target: 'tasks-scheduled-all' },
  { from: ['tasks-scheduled-create-', 'tasks-scheduled-edit-'], selector: '[role="dialog"][aria-labelledby="cron-task-dialog-title"] button', text: '取消', target: 'tasks-scheduled-all' },
  { from: 'tasks-scheduled-delete', selector: '[role="dialog"][aria-labelledby="confirm-dialog-title"] button', text: '取消', target: 'tasks-scheduled-all' },

  ...[['agents', 'subagents-grid'], ['templates', 'subagents-templates-grid']].map(([tab, target]) => ({
    from: 'subagents-', selector: `main [role="tablist"][aria-label="Agent"] > button[role="tab"][aria-controls$="-content-${tab}"]`, target,
  })),
  ...[['agents', 'subagents'], ['templates', 'subagents-templates']].flatMap(([tab, scene]) => [['网格视图', 'grid'], ['列表视图', 'list']].map(([label, view]) => ({
    from: 'subagents-', selector: `main [role="tabpanel"][id$="-content-${tab}"] button[aria-label="${label}"]`, target: `${scene}-${view}`,
  }))),
  { from: 'subagents-', selector: 'main [data-orientation="horizontal"] > div > div > button', text: '新增 Agent', target: 'subagents-create' },
  { from: 'subagents-', selector: 'main [role="tabpanel"][id$="-content-agents"] button[aria-label="编辑 researcher"]', target: 'subagents-edit-basic' },
  ...[['基本信息', 'basic'], ['人设', 'persona'], ['技能', 'skills'], ['Tool', 'tools']].map(([text, tab]) => ({
    from: ['subagents-edit-', 'subagents-persona-soul'], selector: '[role="dialog"][aria-label="编辑子Agent"] button[role="tab"]', text, target: `subagents-edit-${tab}`,
  })),
  { from: ['subagents-edit-persona', 'subagents-persona-soul'], selector: '[role="dialog"][aria-label="编辑子Agent"] aside button', text: 'SOUL.md', target: 'subagents-persona-soul' },
  { from: ['subagents-edit-persona', 'subagents-persona-soul'], selector: '[role="dialog"][aria-label="编辑子Agent"] aside button', text: 'AGENTS.md', target: 'subagents-edit-persona' },
  { from: ['subagents-create', 'subagents-edit-', 'subagents-persona-soul', 'subagents-delete'], selector: 'section[role="dialog"] > header button[aria-label="关闭"]', target: 'subagents-grid' },
  { from: ['subagents-create', 'subagents-edit-', 'subagents-persona-soul'], selector: 'section[role="dialog"] button', text: '取消', target: 'subagents-grid' },
  { from: ['subagents-templates-', 'subagents-template-load'], selector: 'main [role="tabpanel"][id$="-content-templates"] article:first-child button', text: '查看模板', target: 'subagents-template-load', index: 0 },
  { from: 'subagents-template-load', selector: 'section[role="dialog"][aria-label="加载模板：研究分析助手"] button[aria-label="关闭"]', target: 'subagents-templates-grid' },
  { from: 'subagents-template-load', selector: 'section[role="dialog"][aria-label="加载模板：研究分析助手"] button', text: '取消', target: 'subagents-templates-grid' },
  { from: 'subagents-cloud-', selector: '[role="dialog"] > button', text: 'Close', target: 'subagents-grid' },

  { from: 'teams-list', selector: 'main section > header button', text: '创建团队', target: 'teams-create-teamskill' },
  { from: 'teams-list', selector: 'main section > div > div.grid button', text: '打开', target: 'teams-workflow', index: 0 },
  ...[['加载 TeamSkill', 'teamskill'], ['选择队员', 'manual']].map(([text, tab]) => ({
    from: 'teams-create-', selector: '[role="dialog"] button[role="tab"]', text, target: `teams-create-${tab}`,
  })),
  { from: 'teams-create-', selector: '[role="dialog"] > header button[aria-label="取消"]', target: 'teams-list' },
  { from: 'teams-create-', selector: '[role="dialog"] > footer button', text: '取消', target: 'teams-list' },
  { from: 'teams-', selector: 'main section > header button', text: '返回团队列表', target: 'teams-list' },
  { from: teamWorkflowScenes, selector: 'main button[role="combobox"][aria-label="运行记录"]', target: 'teams-run-history' },
  { from: 'teams-run-history', selector: '[role="option"][title="teamrun-design01-current"]', target: 'teams-workflow' },
  { from: 'teams-run-history', selector: '[role="option"][title="teamrun-design00-previous"]', target: 'teams-run-completed' },
  ...['start', 'research', 'review', 'approval', 'quality', 'join', 'end'].map((node) => ({
    from: teamWorkflowScenes, selector: `main [data-team-graph-canvas="true"] [data-node-id="${node}"][role="button"]`, target: `teams-node-${node}`,
  })),
  { from: teamWorkflowScenes, selector: 'main [data-team-graph-canvas="true"] path[role="button"][aria-label="资料研究 → 方案审核: completed"]', target: 'teams-edge-inspector' },
  { from: 'teams-edge-inspector', selector: 'main [data-team-graph-canvas="true"] path[aria-label="资料研究 → 方案审核: completed"] ~ foreignObject button', text: 'completed', target: 'teams-edge-inspector' },
  { from: ['teams-node-', 'teams-edge-inspector'], selector: '[role="dialog"] > header button[aria-label="关闭"]', target: 'teams-workflow' },
  { from: ['teams-node-', 'teams-edge-inspector'], selector: '[role="dialog"] button', text: '取消', target: 'teams-workflow' },
];
