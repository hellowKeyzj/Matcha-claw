// Synthetic HTTP data only; production pages, stores and decoders remain the rendering authority.
const capturedAt = Date.UTC(2026, 9, 22, 10, 30);
const nativeEndpoint = (runtimeAdapterId) => ({ kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId: 'local' });
const settingsCallId = '51000000000000000000000000000001';
const diagnosticsCallId = '51000000000000000000000000000002';
const runtimeCallId = '51000000000000000000000000000003';
const failedCallId = '51000000000000000000000000000004';
const archiveId = '52000000000000000000000000000001';

const engineCatalog = [
  ['bing', ['general'], true, true, true],
  ['google', ['general'], true, true, true],
  ['duckduckgo', ['general'], true, true, true],
  ['baidu', ['general'], false, true, false],
  ['brave', ['general'], true, true, true],
  ['wikipedia', ['general'], true, true, false],
  ['bing images', ['images'], true, true, true],
  ['google images', ['images'], false, true, true],
  ['openverse', ['images', 'stock images'], true, false, true],
  ['unsplash', ['images', 'stock images'], false, false, false],
  ['bing news', ['news'], true, true, true],
  ['google news', ['news'], false, true, false],
  ['reuters', ['news'], true, false, false],
  ['bing videos', ['videos'], false, true, true],
  ['youtube', ['videos', 'music'], true, true, true],
  ['bilibili', ['videos'], false, true, false],
  ['github', ['it', 'repos'], true, false, false],
  ['stackoverflow', ['it', 'q&a'], true, false, false],
  ['mdn', ['it'], true, true, false],
  ['npm', ['it', 'packages'], false, false, false],
  ['crates.io', ['it', 'cargo', 'packages'], true, false, false],
  ['pypi', ['it', 'packages'], false, false, false],
  ['arxiv', ['science', 'scientific publications'], true, false, false],
  ['crossref', ['science'], false, false, false],
  ['pubmed', ['science', 'scientific publications'], true, false, false],
  ['openlibrary', ['books'], true, true, false],
  ['wiktionary', ['dictionaries'], false, true, false],
  ['openstreetmap', ['map'], true, true, false],
].map(([name, categories, enabled, languageSupport, safeSearch]) => ({
  name, categories, enabled, languageSupport, safeSearch, timeoutSeconds: 8,
}));

function runtimeSettings(scenarioId) {
  return {
    browserMode: scenarioId === 'settings-browser-off' ? 'off' : scenarioId === 'settings-browser-native' ? 'native' : 'relay',
    launchAtStartup: false,
    gatewayAutoStart: true,
    proxyEnabled: scenarioId.includes('gateway-proxy'),
    proxyServer: scenarioId.includes('gateway-proxy') ? 'http://127.0.0.1:7890' : '',
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
  };
}

function searchSnapshot(scenarioId) {
  const phase = ['stopped', 'preparing', 'starting', 'failed'].find((value) => scenarioId === `settings-search-service-${value}`) ?? 'running';
  const runtimes = ['openclaw', 'matcha-agent'].map((id) => ({
    endpoint: nativeEndpoint(id),
    enabled: true,
    phase: scenarioId === 'settings-search-runtimes-pending' ? 'pendingRestart'
      : scenarioId === 'settings-search-runtimes-failed' && id === 'openclaw' ? 'failed' : 'ready',
    error: scenarioId === 'settings-search-runtimes-failed' && id === 'openclaw'
      ? '示例：运行时尚未加载搜索工具，请重新加载会话。' : null,
  }));
  return {
    revision: 12,
    appliedRevision: scenarioId === 'settings-search-unapplied' ? 11 : 12,
    config: {
      enabled: true, autoStart: true, categories: ['general'], language: 'all', safeSearch: 1,
      resultCount: 5, requestTimeoutSeconds: 20, proxyUrl: null,
      engines: engineCatalog.map(({ name, enabled }) => ({ name, enabled, timeoutSeconds: null, weight: null })),
      runtimes: runtimes.map(({ endpoint, enabled }) => ({ endpoint, enabled })),
    },
    service: { phase, error: phase === 'failed' ? '示例：搜索服务启动失败，请准备服务后重试。' : null },
    engines: engineCatalog.map((engine) => ({ ...engine, categories: [...engine.categories] })),
    runtimes,
  };
}

function licenseValidation(scenarioId, key) {
  const code = scenarioId === 'settings-license-invalid' ? 'format_invalid'
    : scenarioId === 'settings-license-expired' ? 'expired'
      : key !== undefined && !key.trim() ? 'empty'
        : scenarioId === 'settings-license-offline' ? 'cache_grace_valid' : 'valid';
  const valid = code === 'valid' || code === 'cache_grace_valid';
  return {
    valid, code, mode: scenarioId === 'settings-license-offline' ? 'cache' : 'online',
    source: scenarioId === 'settings-license-offline' ? 'cache' : 'server',
    masked: 'MATCHA-••••-••••-D3M0', last4: 'D3M0',
    expiresAt: code === 'expired' ? '2026-10-20T23:59:59.000Z' : '2027-10-22T23:59:59.000Z',
    refreshAfterSec: 3600,
    offlineGraceUntilMs: Date.UTC(2026, 9, 29, 23, 59),
  };
}

function licenseGate(scenarioId) {
  const checking = scenarioId === 'settings-license-checking';
  const hasStoredKey = !['settings-license-blocked', 'settings-license-invalid', 'settings-license-checking'].includes(scenarioId);
  const blocked = ['settings-license-blocked', 'settings-license-invalid', 'settings-license-expired'].includes(scenarioId);
  return {
    state: checking ? 'checking' : blocked ? 'blocked' : 'granted',
    reason: checking ? 'startup' : blocked ? 'validation_failed' : 'validated',
    checkedAtMs: capturedAt,
    hasStoredKey,
    hasUsableCache: !checking && !blocked,
    nextRevalidateAtMs: checking || blocked ? null : capturedAt + 3_600_000,
    lastValidation: checking || scenarioId === 'settings-license-blocked' ? null : licenseValidation(scenarioId),
    renewalAlert: scenarioId === 'settings-license-renewal' ? 'near_expiry_renew_failed' : null,
  };
}

function settingsCall(scenarioId) {
  return {
    callId: settingsCallId, module: 'settings', command: 'settings.replace', status: 'succeeded',
    start: capturedAt - 60_000, end: capturedAt - 59_680, revision: 3,
    detail: {
      operation: 'replaceDesired', settlement: { revision: 12, outcome: 'confirmed' },
      launchAtStartup: runtimeSettings(scenarioId).launchAtStartup, failure: null,
    },
  };
}

function diagnosticsCall() {
  return {
    callId: diagnosticsCallId, module: 'diagnostics', command: 'diagnostics.archive', status: 'succeeded',
    start: capturedAt - 120_000, end: capturedAt - 118_400, revision: 3,
    detail: { kind: 'collectArchive', receipt: { archiveId, terminal: 'completed', entries: 18, bytes: 246_720 }, failure: null },
  };
}

function runtimeCall(failed = false) {
  return {
    callId: failed ? failedCallId : runtimeCallId,
    module: 'runtime-control', command: failed ? 'lifecycle.restart' : 'lifecycle.repair', status: failed ? 'failed' : 'succeeded',
    start: capturedAt - (failed ? 240_000 : 180_000), end: capturedAt - (failed ? 234_200 : 176_500), revision: 3,
    detail: {
      endpoint: nativeEndpoint('openclaw'), lifecycle: failed ? 'failed' : 'running', result: failed ? 'failed' : 'succeeded',
      count: null, ready: !failed, healthy: !failed, failure: failed ? 'readiness' : null,
      startupDiagnostic: failed ? 'portConflict' : null, error: failed ? 'commandFailed' : null,
      repair: failed ? null : { phase: 'succeeded', trigger: 'manual', failure: null },
    },
  };
}

function callHistory(call, afterRevision = 0) {
  const initialDetail = call.module === 'settings'
    ? { operation: 'replaceDesired', settlement: null, launchAtStartup: null, failure: null }
    : call.module === 'diagnostics' ? { kind: 'collectArchive', receipt: null, failure: null }
      : { ...call.detail, lifecycle: 'starting', result: null, ready: false, healthy: false, failure: null, startupDiagnostic: null, error: null, repair: null };
  return {
    items: [
      { revision: 1, status: 'accepted', at: call.start, detail: initialDetail },
      { revision: 2, status: 'running', at: call.start + 80, detail: initialDetail },
      { revision: 3, status: call.status, at: call.end, detail: call.detail },
    ].filter(({ revision }) => revision > (afterRevision ?? 0)),
    next: null,
  };
}

const httpError = (status, error) => ({ __designHttpStatus: status, json: { error } });

export function settingsFixture(path, body, context = {}) {
  const scenarioId = context.scenarioId ?? '';
  if (path === '/api/settings') return runtimeSettings(scenarioId);
  if (path === '/api/settings/desired') return { callId: settingsCallId, accepted: true };
  if (path === '/api/settings/desired/projection') return { desired: { revision: 12, outcome: 'confirmed' } };
  if (path.startsWith('/api/settings/')) {
    const key = decodeURIComponent(path.slice('/api/settings/'.length));
    const snapshot = runtimeSettings(scenarioId);
    return Object.hasOwn(snapshot, key) ? { value: snapshot[key] } : {};
  }
  if (path === '/api/app/browser-relay-info') return {
    relativeDir: 'resources/tools/data/extension/chrome-extension/browser-relay',
    extensionDir: 'C:\\MatchaClaw-Demo\\resources\\tools\\data\\extension\\chrome-extension\\browser-relay',
    exists: true, chromeExtensionsUrl: 'chrome://extensions/',
  };
  if (path === '/api/openclaw/cli-command') return {
    success: true, command: '& "C:\\MatchaClaw-Demo\\runtime\\node.exe" "C:\\MatchaClaw-Demo\\openclaw\\openclaw.mjs"',
  };
  if (path === '/api/openclaw/logs') return { content: [
    '2026-10-22T10:29:00.000Z [gateway] starting local endpoint',
    '2026-10-22T10:29:01.000Z [gateway] listening on ws://127.0.0.1:18789',
    '2026-10-22T10:29:02.000Z [browser] relay extension connected (synthetic)',
    '2026-10-22T10:29:03.000Z [health] runtime ready',
  ].join('\n') };
  if (path === '/api/openclaw/logs/dir') return { dir: 'C:\\MatchaClaw-Demo\\logs\\openclaw' };
  if (path === '/api/gateway/repair') return {
    phase: scenarioId === 'settings-gateway-repair-running' ? 'repairing' : scenarioId === 'settings-gateway-repair-failed' ? 'failed' : 'idle',
    trigger: scenarioId === 'settings-gateway-repair-running' || scenarioId === 'settings-gateway-repair-failed' ? 'automatic' : null,
    failure: scenarioId === 'settings-gateway-repair-failed' ? 'doctorTimedOut' : null,
  };
  if (path === '/api/matcha-agent/app-server/status') return {
    processState: scenarioId === 'settings-gateway-service-failed' ? 'failed' : 'running',
    port: 19110, pid: 24680, ready: scenarioId !== 'settings-gateway-service-failed',
    lastError: scenarioId === 'settings-gateway-service-failed' ? '示例：本地服务尚未就绪，请刷新后重试。' : null,
    updatedAt: capturedAt,
  };
  if (path === '/api/search') return searchSnapshot(scenarioId);
  if (path === '/api/search/config') {
    const snapshot = searchSnapshot(scenarioId);
    return { ...snapshot, revision: 13, appliedRevision: 13, config: body.config };
  }
  if (['/api/search/prepare', '/api/search/restart', '/api/search/stop'].includes(path)) {
    const snapshot = searchSnapshot(scenarioId);
    return { ...snapshot, service: { phase: path.endsWith('/stop') ? 'stopped' : 'running', error: null } };
  }
  if (path === '/api/search/logs') return { lines: [
    '2026-10-22T10:29:00Z [search] loading synthetic engine catalog',
    '2026-10-22T10:29:01Z [search] configuration revision=12 applied=12',
    '2026-10-22T10:29:02Z [search] local search service ready',
    '2026-10-22T10:29:03Z [search] runtime integrations ready: openclaw, matcha-agent',
  ] };
  if (path === '/api/search/verify') {
    if (scenarioId === 'settings-search-verification-failed') return httpError(503, '示例：搜索验证暂不可用，请检查服务状态后重试。');
    return {
      results: [
        { title: '浏览器自动化入门 · 示例文档', url: 'https://docs.example.com/browser/automation', snippet: '了解观察页面、执行操作与核验结果的完整流程。此条目为合成示例。' },
        { title: '网络搜索与运行时接入 · 示例指南', url: 'https://docs.example.com/search/runtime', snippet: '配置搜索源、默认类别与运行时工具链，使用验证面板确认接入状态。' },
        { title: '安全使用浏览器扩展 · 示例手册', url: 'https://docs.example.com/browser/relay', snippet: '介绍扩展安装、浏览器连接以及最小权限设置。' },
      ],
      unresponsiveEngines: scenarioId === 'settings-search-verification-partial' ? { google: 'timeout' } : {},
      elapsedMs: 386,
    };
  }
  if (path === '/api/license/gate') return scenarioId === 'settings-license-unavailable'
    ? httpError(503, '示例授权服务暂不可用') : licenseGate(scenarioId);
  if (path === '/api/license/stored-key') {
    if (scenarioId === 'settings-license-key-unavailable') return httpError(503, '示例：无法读取授权码摘要');
    const { hasStoredKey } = licenseGate(scenarioId);
    return { hasStoredKey, masked: hasStoredKey ? 'MATCHA-••••-••••-D3M0' : null, last4: hasStoredKey ? 'D3M0' : null };
  }
  if (path === '/api/license/validate') return licenseValidation(scenarioId, body?.key);
  if (path === '/api/license/revalidate') return licenseValidation(scenarioId);
  if (path === '/api/license/clear') return { success: true };
  if (path === '/api/diagnostics/archive') return { callId: diagnosticsCallId, accepted: true };
  if (path === '/api/diagnostics/memory') return {
    sampledAt: new Date(capturedAt).toISOString(),
    mainProcess: { rss: 134_217_728, heapTotal: 67_108_864, heapUsed: 41_943_040, external: 2_097_152, arrayBuffers: 524_288 },
    electronProcesses: { processCount: 2, totalWorkingSetKb: 262_144, byType: [
      { type: 'Browser', processCount: 1, totalWorkingSetKb: 131_072, totalPrivateBytesKb: 98_304 },
      { type: 'Tab', processCount: 1, totalWorkingSetKb: 131_072, totalPrivateBytesKb: 98_304 },
    ], processes: [
      { pid: 24680, type: 'Browser', creationTime: capturedAt - 300_000, workingSetSizeKb: 131_072, peakWorkingSetSizeKb: 147_456, privateBytesKb: 98_304, sharedBytesKb: 32_768 },
      { pid: 24681, type: 'Tab', creationTime: capturedAt - 300_000, workingSetSizeKb: 131_072, peakWorkingSetSizeKb: 139_264, privateBytesKb: 98_304, sharedBytesKb: 32_768 },
    ] },
  };
  if (path === '/api/diagnostics/archive/download') return httpError(503, '设计导出不生成真实诊断 ZIP，请使用合成导出回执。');
  if (path === '/api/calls/list' || path === '/api/calls/get' || path === '/api/calls/history') {
    const calls = [settingsCall(scenarioId), diagnosticsCall(), runtimeCall(), runtimeCall(true)];
    if (path === '/api/calls/list') return {
      items: scenarioId === 'settings-calls-empty' ? [] : calls.filter((call) => (!body?.module || call.module === body.module) && (!body?.status || call.status === body.status)),
      next: null,
    };
    const call = calls.find(({ callId }) => callId === body?.callId);
    if (!call) return undefined;
    return path === '/api/calls/get' ? call : callHistory(call, body?.afterRevision);
  }
  return undefined;
}

const button = (name, index = 0) => ({ role: 'button', name, exact: true, index });
const tab = (name) => ({ role: 'tab', name, exact: true, index: 0 });
const settingsSource = 'src/plugins/settings/page.tsx';
const searchSource = 'src/plugins/search/pages/';
function scene(id, title, section, options = {}) {
  const { sources = [], ...details } = options;
  return { id: `settings-${id}`, title, group: '设置', route: `/settings?section=${section}`, sources: [settingsSource, ...sources], actions: [], ...details };
}
const searchScene = (id, title, options = {}) => scene(`search-${id}`, title, 'search', {
  ...options, sources: [`${searchSource}index.tsx`, ...(options.sources ?? [])],
});
const advancedTab = tab('高级设置');
const runtimeTab = tab('运行时接入');
const verificationActions = [button('验证服务'), { css: '.network-search-verification input', fill: '浏览器自动化' }, button('开始验证')];

export const settingsScenarios = [
  scene('gateway', '运行状态', 'gateway', { waitFor: '自动启动 OpenClaw' }),
  scene('gateway-logs', '运行状态 · OpenClaw 日志', 'gateway', { actions: [button('日志')], waitFor: '[health] runtime ready' }),
  scene('gateway-proxy', '运行状态 · 代理设置展开', 'gateway', { actions: [{ css: '[data-testid="settings-proxy-expand"]' }], waitFor: '代理服务器' }),
  scene('gateway-proxy-draft', '运行状态 · 代理设置未保存', 'gateway', { actions: [{ css: '[data-testid="settings-proxy-expand"]' }, { css: '#proxy-server', fill: 'http://127.0.0.1:7891' }], waitFor: '保存后会立即重新应用 Electron 网络代理，并自动重启 Gateway。' }),
  scene('gateway-repair-confirm', '运行状态 · 修复确认', 'gateway', { actions: [button('修复')], waitFor: '修复 OpenClaw？' }),
  scene('gateway-repair-running', '运行状态 · 自动修复中', 'gateway', { waitFor: '正在修复', sources: ['src/types/runtime-repair.ts'] }),
  scene('gateway-repair-failed', '运行状态 · 修复超时', 'gateway', { waitFor: 'OpenClaw 原生修复执行超时，请查看日志。', sources: ['src/types/runtime-repair.ts'] }),
  scene('gateway-service-failed', '运行状态 · 本地服务异常', 'gateway', { waitFor: '示例：本地服务尚未就绪，请刷新后重试。' }),
  scene('appearance', '通用 · 主题与语言', 'appearance', { waitFor: '上传头像' }),
  scene('appearance-dark', '通用 · 深色主题', 'appearance', { actions: [button('深色')], waitFor: '上传头像' }),
  scene('browser-relay', '浏览器 · 扩展模式', 'browser', { waitFor: '打开 Chrome 扩展管理页面并启用开发者模式' }),
  scene('browser-native', '浏览器 · 原生模式', 'browser', { waitFor: '当前使用原生 Browser' }),
  scene('browser-off', '浏览器 · 已关闭', 'browser', { waitFor: '浏览器能力已关闭' }),
  searchScene('sources', '网络搜索 · 搜索源', { sources: [`${searchSource}Sources.tsx`, 'src/types/network-search.ts'], waitFor: '默认搜索源' }),
  searchScene('category-images', '网络搜索 · 图片搜索源', { actions: [button('图片')], waitFor: '必应图片', sources: [`${searchSource}Sources.tsx`] }),
  searchScene('more-categories', '网络搜索 · 更多类别菜单', { actions: [{ css: '.network-search-more-categories' }], waitFor: '图书', sources: [`${searchSource}SearchSelect.tsx`] }),
  searchScene('sources-next-page', '网络搜索 · 搜索源下一页', { actions: [button('下一页')], waitFor: '开放图书馆', sources: [`${searchSource}Sources.tsx`] }),
  searchScene('sources-no-match', '网络搜索 · 无匹配搜索源', { actions: [{ css: 'input[type="search"]', fill: '不存在的合成引擎' }], waitFor: '没有匹配的搜索源', sources: [`${searchSource}Sources.tsx`] }),
  searchScene('add-engine', '网络搜索 · 添加引擎内联表单', { actions: [button('添加引擎'), { css: '#network-search-add-engine input', fill: 'example-search' }], waitFor: '取消添加', sources: [`${searchSource}Sources.tsx`] }),
  searchScene('custom-engine-draft', '网络搜索 · 自定义引擎草稿', { actions: [button('添加引擎'), { css: '#network-search-add-engine input', fill: 'example-search' }, { css: '#network-search-add-engine button[type="submit"]' }], waitFor: 'example-search', sources: [`${searchSource}Sources.tsx`] }),
  searchScene('engine-sheet', '网络搜索 · 搜索源配置抽屉', { actions: [button('配置 必应')], waitFor: '搜索源详情', sources: [`${searchSource}EngineDrawer.tsx`] }),
  searchScene('verification', '网络搜索 · 验证服务表单', { actions: [button('验证服务')], waitFor: '验证已生效的服务配置', sources: [`${searchSource}Verification.tsx`] }),
  searchScene('verification-results', '网络搜索 · 服务验证结果', { actions: verificationActions, waitFor: '浏览器自动化入门 · 示例文档', sources: [`${searchSource}Verification.tsx`] }),
  searchScene('verification-partial', '网络搜索 · 部分搜索源未响应', { actions: verificationActions, waitFor: '部分搜索源未响应', sources: [`${searchSource}Verification.tsx`] }),
  searchScene('verification-failed', '网络搜索 · 服务验证失败', { actions: verificationActions, waitFor: '示例：搜索验证暂不可用，请检查服务状态后重试。', sources: [`${searchSource}Verification.tsx`] }),
  searchScene('runtimes', '网络搜索 · 运行时接入', { actions: [runtimeTab], waitFor: 'matcha-agent', sources: [`${searchSource}Runtimes.tsx`] }),
  searchScene('runtimes-pending', '网络搜索 · 接入等待重启', { actions: [runtimeTab], waitFor: '原生配置已保存，当前会话需重启或重新加载。', sources: [`${searchSource}Runtimes.tsx`] }),
  searchScene('runtimes-failed', '网络搜索 · 运行时接入失败', { actions: [runtimeTab], waitFor: '示例：运行时尚未加载搜索工具，请重新加载会话。', sources: [`${searchSource}Runtimes.tsx`] }),
  searchScene('runtime-openclaw-verification', '网络搜索 · OpenClaw 工具链验证', { actions: [runtimeTab, button('验证接入', 0), { css: '.network-search-verification input', fill: '浏览器自动化' }, button('开始验证')], waitFor: '浏览器自动化入门 · 示例文档', sources: [`${searchSource}Runtimes.tsx`, `${searchSource}Verification.tsx`] }),
  searchScene('runtime-matcha-verification', '网络搜索 · matcha-agent 工具链验证', { actions: [runtimeTab, button('验证接入', 1)], waitFor: '验证 matcha-agent 工具链路', sources: [`${searchSource}Runtimes.tsx`] }),
  searchScene('advanced', '网络搜索 · 高级设置', { actions: [advancedTab], waitFor: '搜索默认值', sources: [`${searchSource}Advanced.tsx`] }),
  searchScene('language-menu', '网络搜索 · 搜索语言菜单', { actions: [advancedTab, { css: '#search-language' }], waitFor: '跟随请求语言', sources: [`${searchSource}Advanced.tsx`, `${searchSource}SearchSelect.tsx`] }),
  searchScene('safe-search-menu', '网络搜索 · 安全过滤菜单', { actions: [advancedTab, { css: '#search-safe-search' }], waitFor: '严格', sources: [`${searchSource}SearchSelect.tsx`] }),
  searchScene('default-categories', '网络搜索 · 默认类别菜单', { actions: [advancedTab, button('添加类别')], waitFor: '学术文献', sources: [`${searchSource}Advanced.tsx`] }),
  searchScene('logs', '网络搜索 · 服务日志', { actions: [advancedTab, button('查看日志')], waitFor: '[search] local search service ready', sources: [`${searchSource}Advanced.tsx`] }),
  searchScene('invalid-defaults', '网络搜索 · 默认值校验', { actions: [advancedTab, { css: '#search-result-count', fill: '0' }], waitFor: '语言码无效，或结果数量不在 1–10、超时不在 1–120 秒范围内。' }),
  searchScene('invalid-proxy', '网络搜索 · 代理地址校验', { actions: [advancedTab, { css: '#search-proxy', fill: 'https://example.com/search?token=demo' }], waitFor: '请输入 http、https、socks5 或 socks5h 代理端点，不含账号、密码、路径或查询参数。' }),
  searchScene('revisions', '网络搜索 · 配置版本详情', { actions: [{ css: '.network-search-save-details > summary' }], waitFor: '已保存 v12 · 已应用 12' }),
  searchScene('unapplied', '网络搜索 · 配置尚未应用', { waitFor: '已保存配置尚未完全应用，请检查服务和运行时状态。' }),
  ...[
    ['stopped', '服务已停止', '服务已停止'],
    ['preparing', '服务准备中', '正在准备服务'],
    ['starting', '服务启动中', '服务正在启动'],
    ['failed', '服务启动失败', '示例：搜索服务启动失败，请准备服务后重试。'],
  ].map(([phase, title, waitFor]) => searchScene(`service-${phase}`, `网络搜索 · ${title}`, { waitFor })),
  ...[
    ['idle', '检查更新', '检查更新以获取最新功能'],
    ['available', '发现新版本', '下载更新'],
    ['downloading', '下载进度', '正在下载更新...'],
    ['downloaded', '等待安装', '安装并重启'],
    ['error', '更新失败', '错误详情：'],
  ].map(([status, title, waitFor]) => scene(`updates-${status}`, `更新 · ${title}`, 'updates', { waitFor, sources: ['src/plugins/settings/update/UpdateSettings.tsx', 'src/plugins/settings/update/store.ts'] })),
  scene('advanced-locked', '高级 · 开发者模式关闭', 'advanced', { waitFor: '显示开发者工具和快捷方式' }),
  scene('advanced', '高级 · 开发者工具', 'advanced', { waitFor: '埋点查看器' }),
  scene('advanced-telemetry', '高级 · 埋点查看器展开', 'advanced', { actions: [button('显示')], waitFor: '事件聚合', sources: ['src/lib/telemetry.ts'] }),
  scene('advanced-telemetry-history', '高级 · 历史事件筛选', 'advanced', {
    sources: ['src/lib/telemetry.ts'],
    prepare: async (page) => {
      await page.getByRole('button', { name: '显示', exact: true }).click();
      const row = page.locator('div.flex.items-center.justify-between').filter({ has: page.locator('label', { hasText: '仅历史事件' }) });
      await row.getByRole('switch').click();
      await page.getByRole('button', { name: '全部', exact: true }).click();
    },
    waitFor: 'chat.history_load_total',
  }),
  ...[
    ['granted', '已授权', '已授权'],
    ['checking', '检查中', '检查中'],
    ['blocked', '未授权', '云账号登录无需激活'],
    ['invalid', '授权码无效', '授权码格式有误'],
    ['expired', '授权已过期', '授权已过期'],
    ['offline', '离线授权', '离线可用至：'],
    ['renewal', '续期失败提醒', '授权即将过期，续期失败，请重新校验'],
    ['unavailable', '状态不可用', '状态读取失败，请刷新'],
    ['key-unavailable', '授权码摘要不可用', '授权码读取失败，请刷新'],
  ].map(([state, title, waitFor]) => scene(`license-${state}`, `授权 · ${title}`, 'license', { waitFor, sources: ['src/plugins/account/settings/LicenseSection.tsx', 'src/lib/license.ts'] })),
  scene('license-replace', '授权 · 更换授权码', 'license', { actions: [button('更换授权码'), { css: '#settings-license-key', fill: 'MATCHA-DEMO-NOT-A-REAL-LICENSE' }], waitFor: '保存并校验', sources: ['src/plugins/account/settings/LicenseSection.tsx'] }),
  scene('license-reveal', '授权 · 显示待校验授权码', 'license', { actions: [button('更换授权码'), { css: '#settings-license-key', fill: 'MATCHA-DEMO-NOT-A-REAL-LICENSE' }, button('显示授权码')], waitFor: '保存并校验', sources: ['src/plugins/account/settings/LicenseSection.tsx'] }),
  scene('license-clear-confirm', '授权 · 清除确认', 'license', { actions: [button('清除授权')], waitFor: '清除授权？', sources: ['src/plugins/account/settings/LicenseSection.tsx'] }),
  scene('diagnostics', '诊断导出', 'diagnostics', { waitFor: '导出诊断包', sources: ['src/lib/diagnostics-archive.ts'] }),
  scene('diagnostics-exported', '诊断导出 · 完成回执', 'diagnostics', { actions: [button('导出诊断包')], waitFor: '最近一次归档', sources: ['src/lib/diagnostics-archive.ts', 'src/types/call-log/diagnostics.ts'] }),
  scene('calls', '调用记录', 'calls', { waitFor: '查看各模块的操作、结果和状态变化。', sources: ['src/plugins/calls/pages/index.tsx', 'src/types/call-log/decode.ts'] }),
  scene('calls-detail', '调用记录 · 详情与变更历史', 'calls', { actions: [{ css: 'tbody tr:first-child button' }], waitFor: '变更历史', sources: ['src/plugins/calls/pages/index.tsx', 'src/types/call-log/settings.ts'] }),
  scene('calls-technical', '调用记录 · 技术信息展开', 'calls', { actions: [{ css: 'tbody tr:first-child button' }, { css: '[role="dialog"] details > summary' }], waitFor: settingsCallId, sources: ['src/plugins/calls/pages/index.tsx', 'src/plugins/calls/pages/call-presentation.ts'] }),
  scene('calls-failed-detail', '调用记录 · 失败诊断详情', 'calls', { actions: [{ css: 'tbody tr:nth-child(4) button' }], waitFor: '变更历史', sources: ['src/plugins/calls/pages/index.tsx', 'src/types/call-log/runtime-directory.ts'] }),
  scene('calls-empty', '调用记录 · 空状态', 'calls', { waitFor: '暂无调用记录', sources: ['src/plugins/calls/pages/index.tsx'] }),
];

export async function seedSettings() {
  const scenarioId = new URLSearchParams(location.search).get('scene') ?? '';
  if (scenarioId.startsWith('settings-advanced')) {
    const { useSettingsStore } = await import('/src/plugins/settings/store.ts');
    useSettingsStore.setState({ devModeUnlocked: scenarioId !== 'settings-advanced-locked' });
  }
  if (scenarioId.startsWith('settings-advanced-telemetry')) {
    const { clearUiTelemetry, trackUiEvent } = await import('/src/lib/telemetry.ts');
    clearUiTelemetry();
    for (const [index, durationMs] of [240, 360, 420, 860, 1250, 630].entries()) {
      trackUiEvent('chat.history_load_total', { strategy: 'cache-first', quiet: false, durationMs, outcome: index === 4 ? 'recovered' : 'success' });
    }
    trackUiEvent('chat.history_load_total', { strategy: 'native', quiet: true, durationMs: 124, outcome: 'success' });
    trackUiEvent('chat.history_request_error', { durationMs: 930, reason: 'synthetic-timeout' });
    trackUiEvent('settings.proxy_saved', { enabled: true });
  }
}
