const fleetTypes = [
  ['connections', 'connections', '设计实验室 SSH'],
  ['environments', 'environments', '设计实验环境'],
  ['managedResources', 'managed-resources', 'Debian 工作容器'],
  ['nodes', 'nodes', '实验室 Linux 节点'],
  ['agents', 'agents', '实验室管理代理'],
  ['runtimes', 'runtimes', '研究运行时'],
  ['endpoints', 'endpoints', 'design-endpoint'],
];
const detailTabs = [['overview', '概览'], ['terminal', '终端'], ['commands', '命令'], ['audit', '审计'], ['capabilities', '能力']];
const registrationForms = [
  'empty', 'ssh-password', 'ssh-private-key', 'container', 'container-token', 'k8s', 'custom', 'vm-password', 'vm-private-key',
  'advanced', 'disabled', 'port-error', 'json-error', 'public-secret-error', 'secret-ref-error', 'k8s-error', 'docker-error', 'api-error',
].map((id) => `fleet-registration-${id}`);
const primaryDetail = (title) => `section:has(> header h2[title="${title}"])`;

export const navigationRules = [
  { from: 'fleet-', selector: '[role="tablist"][aria-label="Remote Fleet 模式"] [role="tab"]', text: '资源', target: 'fleet-connections-overview' },
  { from: 'fleet-', selector: '[role="tablist"][aria-label="Remote Fleet 模式"] [role="tab"]', text: '运维', target: 'fleet-operations-overview' },
  ...fleetTypes.flatMap(([value, slug, title], index) => [
    { from: 'fleet-', selector: `select[aria-label="资源类型"] option[value="${value}"]`, target: `fleet-${slug}-overview` },
    { from: 'fleet-', selector: 'nav[aria-label="资源类型"] button', index, target: `fleet-${slug}-overview` },
    { from: 'fleet-', selector: `section[aria-labelledby="remote-fleet-resource-index-title"] button[aria-pressed]:has([title="${title}"])`, target: `fleet-${slug}-overview` },
    // The selected category, not the tab label alone, determines all five detail targets.
    ...detailTabs.map(([tab, text]) => ({
      from: 'fleet-',
      selector: `main:has(select[aria-label="资源类型"] option[value="${value}"][selected]) [role="tablist"][aria-label="详情"] [role="tab"]`,
      text,
      target: `fleet-${slug}-${tab}`,
    })),
  ]),
  ...[['overview', 0], ['commands', 1], ['audit', 2]].map(([tab, index]) => ({
    from: 'fleet-', selector: 'nav[aria-label="运维"] [role="tab"]', index, target: `fleet-operations-${tab}`,
  })),
  ...[
    ['已禁用节点', 'node-disabled'], ['容器执行节点', 'node-offline'],
    ['容器部署环境', 'environment-deploying'], ['集群异常环境', 'environment-failed'],
    ['保留的外部数据卷', 'resource-external'], ['已撤销管理代理', 'agent-revoked'],
    ['已停止运行时', 'runtime-stopped'], ['design-draining-endpoint', 'endpoint-draining'],
    ['design-retired-endpoint', 'endpoint-retired'], ['外部自定义连接', 'custom-connection'],
    ['外部自定义节点', 'custom-node-terminal'], ['design-custom-endpoint', 'custom-endpoint-terminal'],
  ].map(([title, scene]) => ({
    from: 'fleet-', selector: `section[aria-labelledby="remote-fleet-resource-index-title"] button[aria-pressed]:has([title="${title}"])`, target: `fleet-${scene}`,
  })),
  ...fleetTypes.filter(([value]) => value !== 'managedResources').map(([, slug, title]) => ({
    from: 'fleet-', selector: `${primaryDetail(title)} > header button[aria-label="更多操作"]`, target: `fleet-${slug}-actions-menu`,
  })),
  { from: 'fleet-', selector: `${primaryDetail('设计实验室 SSH')} > header button`, text: '编辑连接', target: 'fleet-registration-edit' },
  { from: 'fleet-environments-actions-menu', selector: '[role="menuitem"]:not([aria-disabled="true"])', text: '删除环境', target: 'fleet-delete-environment-confirm' },
  { from: 'fleet-delete-connection-confirm', selector: '[role="dialog"][aria-labelledby="confirm-dialog-title"] button', text: '取消', target: 'fleet-connections-overview' },
  { from: 'fleet-delete-environment-confirm', selector: '[role="dialog"][aria-labelledby="confirm-dialog-title"] button', text: '取消', target: 'fleet-environments-overview' },
  { from: 'fleet-', selector: 'main button', text: '添加远端', target: 'fleet-registration-empty' },
  ...[
    ['ssh-host', 'ssh-password'], ['container', 'container'], ['k8s-pod', 'k8s'], ['custom', 'custom'], ['vm', 'vm-password'],
  ].map(([value, scene]) => ({
    from: registrationForms, selector: `[role="dialog"] #remote-node-target-kind:not(:disabled) option[value="${value}"]`, target: `fleet-registration-${scene}`,
  })),
  ...[
    ['ssh-auth-method', 'password', 'ssh-password'], ['ssh-auth-method', 'private-key', 'ssh-private-key'],
    ['container-auth', 'none', 'container'], ['container-auth', 'bearer-token', 'container-token'],
    ['vm-auth', 'password', 'vm-password'], ['vm-auth', 'private-key', 'vm-private-key'],
  ].map(([id, value, scene]) => ({
    from: registrationForms, selector: `[role="dialog"] #remote-node-${id}:not(:disabled) option[value="${value}"]`, target: `fleet-registration-${scene}`,
  })),
  { from: ['fleet-registration-empty', 'fleet-registration-ssh-password'], selector: '[role="dialog"] button[aria-expanded="false"]', text: '高级连接设置连接 ID、标签、密钥引用、公开配置和启用状态。', target: 'fleet-registration-advanced' },
  { from: 'fleet-registration-advanced', selector: '[role="dialog"] button[aria-expanded="true"]', text: '高级连接设置连接 ID、标签、密钥引用、公开配置和启用状态。', target: 'fleet-registration-ssh-password' },
  { from: 'fleet-registration-', selector: '[role="dialog"] button', text: 'Close', target: 'fleet-connections-overview' },
  { from: ['fleet-registration-registered', 'fleet-registration-deploy-error'], selector: '[role="dialog"] button', text: '稍后部署', target: 'fleet-connections-overview' },
  ...[
    ['实验室 Linux 节点', 'node'], ['研究运行时', 'runtime'], ['design-endpoint', 'endpoint'],
  ].map(([title, kind]) => ({
    from: 'fleet-', selector: `${primaryDetail(title)} button`, text: '打开终端', target: `fleet-terminal-${kind}-ready`,
  })),
  ...[
    [['fleet-terminal-node-', 'fleet-terminal-connecting', 'fleet-terminal-open-error', 'fleet-terminal-connection-error', 'fleet-terminal-remote-error', 'fleet-terminal-exited', 'fleet-terminal-closed', 'fleet-terminal-reconnect-error'], 'nodes-terminal'],
    ['fleet-terminal-runtime-', 'runtimes-terminal'], ['fleet-terminal-endpoint-', 'endpoints-terminal'],
    ['fleet-custom-terminal-ready', 'custom-endpoint-terminal'],
  ].flatMap(([from, scene]) => ['收起', '关闭终端'].map((text) => ({
    from, selector: '[role="dialog"] button', text, target: `fleet-${scene}`,
  }))),

  { from: 'wiki-library', selector: 'main aside button', text: '产品研究资料库当前', target: 'wiki-wiki' },
  { from: 'wiki-library', selector: 'main main button.grid', text: '产品研究资料库当前C:/DesignExport/knowledge/product-research2026/10/22 17:30:00', target: 'wiki-wiki' },
  { from: 'wiki-library', selector: 'main button', text: '新建资料库', target: 'wiki-library-create' },
  { from: 'wiki-library-create', selector: '[role="dialog"][aria-labelledby="wiki-library-dialog-title"] > div > div:first-child > button', target: 'wiki-library' },
  { from: 'wiki-library-create', selector: '[role="dialog"][aria-labelledby="wiki-library-dialog-title"] button', text: '取消', target: 'wiki-library' },
  ...[
    ['Wiki', 'wiki'], ['来源', 'sources'], ['Review', 'review'], ['问答', 'qa'],
    ['检查', 'lint'], ['搜索', 'search'], ['图谱', 'graph'], ['维护', 'maintenance'],
  ].map(([text, scene]) => ({ from: 'wiki-', selector: 'main [role="tablist"] [role="tab"]', text, target: `wiki-${scene}` })),
  { from: 'wiki-', selector: 'main button[title="资料库"][aria-label="资料库"]', target: 'wiki-library' },
  { from: 'wiki-', selector: 'main button[aria-pressed]', text: '文件', target: 'wiki-files' },
  { from: 'wiki-', selector: 'main button[aria-pressed]', text: '知识', target: 'wiki-wiki' },
  { from: 'wiki-', selector: 'main button[title="wiki/product-research.md"]', target: 'wiki-wiki' },
  { from: 'wiki-', selector: 'main button[title="设置"]', target: 'wiki-sources-settings' },
  { from: ['wiki-sources-settings', 'wiki-sources-embedding-remote'], selector: 'main button[title="设置"]', target: 'wiki-sources' },
  { from: 'wiki-', selector: 'main button[aria-label="编辑"]', target: 'wiki-edit' },
  { from: 'wiki-edit', selector: 'main button[aria-label="预览"]', target: 'wiki-wiki' },
  { from: 'wiki-', selector: 'main button', text: '文件历史', target: 'wiki-history' },
  { from: 'wiki-history', selector: '[role="dialog"] button[aria-label="关闭文件历史"]', target: 'wiki-wiki' },
  { from: 'wiki-', selector: 'main button[aria-pressed="false"]', text: '页面链接', target: 'wiki-page-links' },
  { from: 'wiki-page-links', selector: 'main button[aria-pressed="true"]', text: '页面链接', target: 'wiki-wiki' },
  { from: 'wiki-page-links', selector: 'aside[aria-label="页面链接"] button[aria-label="关闭链接面板"]', target: 'wiki-wiki' },
  { from: 'wiki-lint', selector: 'main button[aria-label="检查规则"]', target: 'wiki-lint-rules' },
  { from: 'wiki-lint-rules', selector: 'main button[aria-label="检查规则"]', target: 'wiki-lint' },
  { from: 'wiki-graph', selector: 'main button[aria-expanded="false"]', text: '筛选', target: 'wiki-graph-filters' },
  { from: 'wiki-graph-filters', selector: 'main button[aria-expanded="true"]', text: '筛选', target: 'wiki-graph' },
  { from: 'wiki-graph', selector: 'main button[aria-pressed="false"]', text: '节点列表', target: 'wiki-graph-list' },
  { from: 'wiki-graph-list', selector: 'main button[aria-pressed="true"]', text: '节点列表', target: 'wiki-graph' },
  { from: 'wiki-search', selector: 'main:has(input[aria-label="搜索"][value="研究"]) button:not([role="tab"])', text: '上下文', target: 'wiki-search-context' },
  { from: 'wiki-maintenance', selector: 'main button:not([role="dialog"] button)', text: '重建分类索引', target: 'wiki-maintenance-rebuild' },
  { from: 'wiki-maintenance', selector: 'main button:not([role="dialog"] button)', text: '清空全部历史', target: 'wiki-maintenance-history-clear' },
  { from: ['wiki-maintenance-rebuild', 'wiki-maintenance-history-clear'], selector: '[role="dialog"][aria-labelledby="confirm-dialog-title"] button', text: '取消', target: 'wiki-maintenance' },

  ...[['数据浏览', 'data'], ['资料来源', 'materials'], ['业务操作', 'actions']].map(([text, scene]) => ({
    from: 'world-', selector: '[role="tablist"][aria-label="业务数据"] [role="tab"]', text, target: `world-${scene}`,
  })),
  { from: 'world-data', selector: 'main button[aria-label="切换世界"]', target: 'world-switch' },
  { from: 'world-switch', selector: 'main button[aria-label="切换世界"]', target: 'world-data' },
  { from: 'world-', selector: 'main button:not([role="tab"])', text: '探索对象', target: 'world-objects' },
  { from: 'world-', selector: 'main button:not([role="tab"])', text: '业务概览', target: 'world-data' },
  { from: ['world-objects', 'world-object-detail'], selector: 'main button[title="project-design-1"], .world-entity-list button', text: 'project-design-1', target: 'world-object-detail' },
  { from: 'world-object-detail', selector: '.world-object-document > header button[aria-label="关闭"]', target: 'world-objects' },
  ...[['上传资料', 'upload'], ['连接业务源', 'connection'], ['导入 Wiki', 'wiki']].map(([text, mode]) => ({
    from: 'world-', selector: 'main button', text, target: `world-materials-${mode}`,
  })),
  ...['upload', 'wiki', 'connection', 'draft'].map((mode, index) => ({
    from: 'world-materials', selector: 'nav.world-entry-grid[aria-label="添加资料方式"] > button', index, target: `world-materials-${mode}`,
  })),
  { from: 'world-materials-', selector: 'main button', text: '返回资料列表', target: 'world-materials' },
  { from: 'world-actions', selector: '.world-heading > button', text: '发起操作', target: 'world-actions-create' },
  { from: 'world-actions-create', selector: 'main.world-panel > header button', text: '取消', target: 'world-actions' },
  ...[['关系画布', 'canvas'], ['定义', 'definition'], ['版本与编译基线', 'version']].map(([text, view]) => ({
    from: 'world-model-', selector: '[role="tablist"][aria-label="模型与规则"] [role="tab"]', text, target: `world-model-${view}`,
  })),
  { from: 'world-model-', selector: '.world-studio-layout button', text: '提出修改', index: 0, target: 'world-model-edit' },
  { from: 'world-model-edit', selector: '.world-studio-layout button', text: '取消编辑', target: 'world-model-definition' },
  { from: 'world-model-', selector: 'main button', text: '从资料创建定义', target: 'world-materials-upload' },
  { from: 'world-', selector: 'main button', text: '审阅变更', target: 'world-changes-pending' },
  { from: ['world-data', 'world-switch'], selector: 'main button', text: '查看模型与规则', target: 'world-model-canvas' },
  ...[['待审变更', 'pending'], ['验证与评测', 'evaluation'], ['发布记录', 'releases']].map(([text, tab]) => ({
    from: 'world-changes-', selector: '[role="tablist"][aria-label="变更审核"] [role="tab"]', text, target: `world-changes-${tab}`,
  })),
  { from: 'world-changes-', selector: '.world-catalog button[aria-pressed]', text: '待验证修订 2统一项目名称和研究阶段的展示约定补充说明: research-project1 项语义操作', target: 'world-changes-detail' },
  { from: 'world-changes-detail', selector: '.world-review-layout > article button', text: '关闭详情', target: 'world-changes-pending' },
  { from: 'world-changes-detail', selector: '.world-detail-panel button', text: '运行独立评测', target: 'world-changes-evaluation-manage' },
  { from: 'world-changes-evaluation', selector: 'main button', text: '运行评测 / 管理测试', target: 'world-changes-evaluation-manage' },
  { from: 'world-changes-evaluation-manage', selector: 'main button', text: '收起评测操作', target: 'world-changes-evaluation' },
  { from: 'world-changes-releases', selector: 'main button[aria-expanded="false"]', text: '回退到历史版本', target: 'world-changes-rollback' },
  { from: 'world-changes-rollback', selector: 'main button[aria-expanded="true"]', text: '取消回退选择', target: 'world-changes-releases' },
  ...[['存储与初始化', 'storage'], ['能力扩展', 'capabilities'], ['处理记录', 'operations']].map(([text, tab]) => ({
    from: 'world-settings-', selector: '[role="tablist"][aria-label="世界设置"] [role="tab"]', text, target: `world-settings-${tab}`,
  })),
];
