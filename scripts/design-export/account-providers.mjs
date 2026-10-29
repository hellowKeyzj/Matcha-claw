// Synthetic renderer data only; no profile, credentials, or network access.
const accounts = [
  { id: 'demo-openai', provider: 'openai', label: 'OpenAI · 工作空间', enabled: true, kind: 'chat', endpoint: 'https://api.openai.com/v1', protocol: 'openAiCompletions', authMode: 'apiKey', revision: 1 },
  { id: 'demo-anthropic', provider: 'anthropic', label: 'Anthropic · 开发', enabled: true, kind: 'chat', protocol: 'anthropicMessages', authMode: 'token', revision: 1 },
  { id: 'demo-google', provider: 'google', label: 'Google · 多模态', enabled: true, kind: 'chat', protocol: 'googleGenerativeAi', authMode: 'apiKey', revision: 1 },
  { id: 'demo-media', provider: 'custom', label: '创意媒体', enabled: true, kind: 'media', endpoint: 'https://media.example.test/v1', mediaProtocol: 'openAi', authMode: 'apiKey', revision: 1 },
  { id: 'demo-ollama', provider: 'ollama', label: 'Ollama · 本地', enabled: true, kind: 'chat', endpoint: 'http://127.0.0.1:11434', protocol: 'openAiCompletions', authMode: 'local', revision: 1 },
  { id: 'demo-oauth', provider: 'openai', label: 'OpenAI · 浏览器授权', enabled: true, kind: 'chat', protocol: 'openAiResponses', authMode: 'oauthBrowser', revision: 1 },
  { id: 'demo-cli', provider: 'anthropic', label: 'Anthropic · CLI 复用', enabled: true, kind: 'chat', protocol: 'anthropicMessages', authMode: 'cliReuse', revision: 1 },
  { id: 'demo-custom', provider: 'custom', label: '兼容聊天服务', enabled: true, kind: 'chat', endpoint: 'https://chat.example.test/v1', protocol: 'openAiResponses', authMode: 'apiKey', revision: 1 },
  { id: 'demo-zai', provider: 'zai', label: 'Z.AI · Code Plan', enabled: true, kind: 'chat', endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'openAiCompletions', authMode: 'apiKey', revision: 1 },
  { id: 'demo-google-media', provider: 'custom', label: 'Google · 媒体创作', enabled: true, kind: 'media', endpoint: 'https://generativelanguage.googleapis.com/v1beta', mediaProtocol: 'google', authMode: 'apiKey', revision: 1 },
];

const models = [
  { accountId: 'demo-openai', modelId: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['chat', 'imageUnderstand'], contextWindow: 1048576, maxTokens: 65536 },
  { accountId: 'demo-openai', modelId: 'gpt-5.5-mini', label: 'GPT-5.5 Mini', capabilities: ['chat', 'imageUnderstand'], contextWindow: 400000, maxTokens: 32768 },
  { accountId: 'demo-anthropic', modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', capabilities: ['chat', 'imageUnderstand'], contextWindow: 200000, maxTokens: 64000 },
  { accountId: 'demo-google', modelId: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash', capabilities: ['chat', 'imageUnderstand'], contextWindow: 1048576, maxTokens: 65536 },
  { accountId: 'demo-media', modelId: 'gpt-image-2', capabilities: ['imageGenerate'], timeoutMs: 180000, aspectRatio: '16:9', resolution: '2K', quality: 'high' },
  { accountId: 'demo-media', modelId: 'wan2.6-t2v', capabilities: ['videoGenerate'], timeoutMs: 300000 },
  { accountId: 'demo-google-media', modelId: 'lyria-3-clip-preview', capabilities: ['musicGenerate'], timeoutMs: 180000 },
  { accountId: 'demo-media', modelId: 'gpt-4o-mini-tts', capabilities: ['tts'] },
  { accountId: 'demo-media', modelId: 'whisper-1', capabilities: ['transcribe'] },
  { accountId: 'demo-ollama', modelId: 'qwen3:8b', capabilities: ['chat'], contextWindow: 32768, maxTokens: 8192 },
  { accountId: 'demo-oauth', modelId: 'gpt-5.5-codex', capabilities: ['chat'], contextWindow: 400000, maxTokens: 32768 },
  { accountId: 'demo-cli', modelId: 'claude-opus-4-6', capabilities: ['chat', 'imageUnderstand'], contextWindow: 200000, maxTokens: 64000 },
  { accountId: 'demo-custom', modelId: 'workspace-chat', capabilities: ['chat', 'imageUnderstand'], contextWindow: 128000, maxTokens: 16384 },
  { accountId: 'demo-zai', modelId: 'glm-5.2', capabilities: ['chat', 'imageUnderstand'], contextWindow: 200000, maxTokens: 32768 },
  { accountId: 'demo-google-media', modelId: 'gemini-3.1-flash-image-preview', capabilities: ['imageGenerate'], timeoutMs: 180000, aspectRatio: '1:1', resolution: '2K' },
];

const routing = {
  revision: 1,
  routes: [
    { capability: 'chat', primary: { accountId: 'demo-openai', modelId: 'gpt-5.5' }, fallbacks: [{ accountId: 'demo-anthropic', modelId: 'claude-sonnet-4-6' }, { accountId: 'demo-ollama', modelId: 'qwen3:8b' }] },
    { capability: 'imageUnderstand', primary: { accountId: 'demo-google', modelId: 'gemini-3.1-flash' }, fallbacks: [{ accountId: 'demo-openai', modelId: 'gpt-5.5' }] },
    { capability: 'imageGenerate', primary: { accountId: 'demo-media', modelId: 'gpt-image-2' }, fallbacks: [], timeoutMs: 180000 },
    { capability: 'videoGenerate', primary: { accountId: 'demo-media', modelId: 'wan2.6-t2v' }, fallbacks: [], timeoutMs: 300000 },
    { capability: 'musicGenerate', primary: { accountId: 'demo-google-media', modelId: 'lyria-3-clip-preview' }, fallbacks: [], timeoutMs: 180000 },
    { capability: 'tts', primary: { accountId: 'demo-media', modelId: 'gpt-4o-mini-tts' }, fallbacks: [] },
  ],
};

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86400000).toISOString();
const user = {
  id: 1, username: 'design-demo', name: '设计示例', email: 'designer@example.test',
  role: 'user', status: 'active', balance: 128, frozenBalance: 12, concurrency: 3, rpmLimit: 120,
  allowedGroups: null, balanceNotifyEnabled: true, balanceNotifyThreshold: 10,
  createdAt: iso(-30), updatedAt: iso(), runMode: 'standard',
};
const publicSettings = {
  registrationEnabled: true, emailVerifyEnabled: true, forceEmailOnThirdPartySignup: false,
  registrationEmailSuffixWhitelist: [], promoCodeEnabled: false, passwordResetEnabled: false,
  invitationCodeEnabled: false, turnstileEnabled: false, turnstileSiteKey: '',
  siteName: 'MatchaClaw', siteLogo: '', siteSubtitle: '你的桌面智能工作空间', contactInfo: '', docUrl: '', homeContent: '',
  compactHomeEnabled: true, paymentEnabled: true, linuxdoOauthEnabled: false, wechatOauthEnabled: false,
  oidcOauthEnabled: false, oidcOauthProviderName: '', githubOauthEnabled: false, googleOauthEnabled: false,
  serviceQuotaEnabled: true, affiliateEnabled: false, version: '1.0.5',
};
const plans = [
  ['轻体验', 'day', 1, 9.9, 12, 30, 60],
  ['创作周卡', 'week', 1, 39, 20, 120, 300],
  ['专业月卡', 'month', 1, 129, 30, 180, 600],
  ['年度伙伴', 'year', 1, 1199, 60, 360, 1200],
  ['弹性加油包', '', 0, 19, null, null, 50],
].map(([name, validityUnit, validityDays, price, dailyLimitUsd, weeklyLimitUsd, monthlyLimitUsd], index) => ({
  id: index + 1, groupId: index + 11, groupPlatform: 'Matcha', groupName: name,
  name, productName: `Matcha ${name}`, description: index === 2 ? '适合日常开发与深度创作，让灵感持续发生。' : '按自己的节奏，探索更高效的智能工作方式。',
  price, originalPrice: Math.round(price * 1.2), currency: 'CNY', validityDays, validityUnit,
  dailyLimitUsd, weeklyLimitUsd, monthlyLimitUsd, rateMultiplier: index === 3 ? 0.8 : 1,
  supportedModelScopes: ['GPT', 'Claude', 'Gemini'],
  features: ['主流旗舰模型随心切换', '对话、编程与多模态创作', '桌面端和自动化工作流'],
  forSale: true, sortOrder: index,
}));
const method = (displayName, feeRate = 0) => ({ currency: 'CNY', displayName, dailyLimit: 10000, dailyUsed: 120, dailyRemaining: 9880, singleMin: 1, singleMax: 5000, feeRate, available: true });
const checkoutInfo = {
  methods: { alipay: method('支付宝'), wechatpay: method('微信支付', 0.6) },
  globalMin: 1, globalMax: 5000, plans, balanceDisabled: false, balanceRechargeMultiplier: 1,
  subscriptionUsdToCnyRate: 7, rechargeFeeRate: 0, helpText: '离线设计示例，不会创建真实支付。', helpImageUrl: '', stripePublishableKey: '',
};
const quota = (used, limit, days) => ({ used, limit, remaining: limit - used, percentage: Math.round(used / limit * 100), windowStart: iso(-1), resetsAt: iso(days), resetInSeconds: days * 86400 });
const progress = [{ subscriptionId: 101, groupName: 'Matcha 专业月卡', expiresAt: iso(23), expiresInDays: 23, daily: quota(8.6, 30, 1), weekly: quota(62.4, 180, 4), monthly: quota(186.8, 600, 23) }];
const subscriptionSummary = {
  activeCount: 1, totalUsedUsd: 186.8,
  subscriptions: [{ id: 101, groupId: 13, groupName: 'Matcha 专业月卡', status: 'active', dailyUsedUsd: 8.6, dailyLimitUsd: 30, weeklyUsedUsd: 62.4, weeklyLimitUsd: 180, monthlyUsedUsd: 186.8, monthlyLimitUsd: 600, dailyProgress: 29, weeklyProgress: 35, monthlyProgress: 31, expiresAt: iso(23), daysRemaining: 23 }],
};
const activeSubscriptions = [{ id: 101, userId: 1, groupId: 13, status: 'active', startsAt: iso(-7), expiresAt: iso(23), dailyUsageUsd: 8.6, weeklyUsageUsd: 62.4, monthlyUsageUsd: 186.8, dailyWindowStart: iso(-1), weeklyWindowStart: iso(-3), monthlyWindowStart: iso(-7), createdAt: iso(-7), updatedAt: iso() }];
const usageHistory = [0.02, 0.1, 0.4, 1.2, 2.1, 3.4, 4.2, 5.1, 6.1, 10, 18, 25, 39].map((days, index) => {
  const model = models[index % 4];
  const inputTokens = 12000 + index * 1357;
  const outputTokens = 2800 + index * 431;
  const cacheReadTokens = 6400 + index * 263;
  const cacheWriteTokens = 1200 + index * 79;
  return {
    timestamp: iso(-days), sessionId: `agent:main:design-usage-${index + 1}`, agentId: index % 3 ? 'main' : 'researcher',
    model: model.modelId, provider: accounts.find((account) => account.id === model.accountId).label,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens, costUsd: Number((0.08 + index * 0.027).toFixed(4)),
  };
});
const discoveries = [
  { modelId: 'gpt-5.5', capabilities: ['chat', 'imageUnderstand'], contextWindow: 1048576, maxTokens: 65536 },
  { modelId: 'gpt-5.5-pro', capabilities: ['chat', 'imageUnderstand'], contextWindow: 1048576, maxTokens: 65536 },
  { modelId: 'gpt-5.5-codex', capabilities: ['chat'], contextWindow: 400000, maxTokens: 32768 },
];
const states = new Map();
function stateFor(context) {
  const id = context.scenarioId || 'default';
  if (!states.has(id)) states.set(id, {
    accounts: id === 'providers-empty' ? [] : structuredClone(accounts.filter((account) => id !== 'providers-code-plan' || account.provider !== 'zai')),
    models: id === 'providers-empty' ? [] : structuredClone(models.filter((model) => id !== 'providers-code-plan' || model.accountId !== 'demo-zai')),
    routing: id === 'providers-empty' ? null : structuredClone(routing), calls: new Map(), order: null,
  });
  return states.get(id);
}
function providerCall(state, command, kind, fields = {}) {
  const callId = `d1${String(state.calls.size + 1).padStart(30, '0')}`;
  state.calls.set(callId, {
    callId, module: 'provider', command, status: 'succeeded', start: now, end: now + 1, revision: 1,
    detail: {
      kind, phase: 'terminal', outcome: 'stored', count: null, acceptedCount: null,
      persisted: 'confirmed', commit: 'committed', native: { changed: true, applied: 'confirmed', observed: 'matches' },
      accountId: null, accountRevision: null, diagnostic: null, ...fields,
    },
  });
  return { callId, accepted: true };
}
const httpError = (message, status = 503) => ({ __designHttpStatus: status, json: { error: message } });

export function accountProvidersFixture(path, body, context = {}) {
  const url = new URL(context.url || path, 'http://design-export.invalid');
  const scene = context.scenarioId || '';
  const state = stateFor(context);
  const noSubscription = scene === 'account-balance';
  if (path === '/api/providers/recovery') return { recovery: scene === 'providers-recovery' ? { backupDirectory: 'C:\\DesignExport\\synthetic-provider-backup' } : null };
  if (path === '/api/providers/recovery/acknowledge' || path === '/api/providers/recovery/open-backup') return { success: true };
  if (path === '/api/provider-accounts') return { accounts: state.accounts };
  if (/^\/api\/provider-accounts\/[^/]+\/has-api-key$/.test(path)) return { hasKey: scene !== 'providers-missing-key' };
  if (path === '/api/provider-models') {
    if (body?.operationId === 'providerModels.replace') {
      const { accountId, models: replacement } = body.input;
      state.models = [...state.models.filter((model) => model.accountId !== accountId), ...replacement.map((model) => ({ ...model, accountId }))];
      return providerCall(state, body.operationId, 'replaceModels', { accountId, count: replacement.length, acceptedCount: replacement.length });
    }
    return { models: state.models };
  }
  if (path === '/api/provider-models/selectable') {
    const capability = url.searchParams.get('capability');
    return { models: state.models.filter((model) => !capability || model.capabilities.includes(capability)).map((model) => ({
      accountId: model.accountId, modelId: model.modelId, label: state.accounts.find((account) => account.id === model.accountId)?.label,
      capabilities: model.capabilities, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      selectionId: `model:design-${model.accountId}-${model.modelId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
      modelReferences: [`${model.accountId}/${model.modelId}`],
    })) };
  }
  if (path === '/api/provider-models/discover') {
    const result = scene === 'providers-discovery-empty' ? [] : discoveries;
    const receipt = providerCall(state, 'providerModels.discover', 'discoverModels', { outcome: 'discovered', accountId: url.searchParams.get('accountId'), count: result.length, persisted: null, commit: null, native: null });
    if (scene === 'providers-discovery-error') {
      const call = state.calls.get(receipt.callId);
      call.status = 'rejected';
      call.detail.outcome = 'rejected';
    }
    return receipt;
  }
  if (path === '/api/provider-models/discovery-result') return { callId: url.searchParams.get('callId'), accountId: url.searchParams.get('accountId'), models: scene === 'providers-discovery-empty' ? [] : discoveries };
  if (path === '/api/provider-routing') {
    if (body?.operationId === 'providerRouting.replace') {
      state.routing = body.input.routing;
      return providerCall(state, body.operationId, 'replaceRouting');
    }
    return { routing: state.routing };
  }
  if (path === '/api/calls/get' && state.calls.has(body?.callId)) return state.calls.get(body.callId);
  if (path === '/api/runtime-host/usage/recent') {
    if (scene === 'dashboard-error') return httpError('离线示例：用量数据暂时不可用');
    return scene === 'dashboard-empty' ? [] : usageHistory;
  }
  if (path === '/api/runtime-host/usage/session-timeseries') {
    if (scene === 'dashboard-detail-empty') return [];
    if (scene === 'dashboard-detail-error') return httpError('离线示例：会话用量明细暂时不可用');
    const entry = usageHistory.find((item) => item.sessionId === url.searchParams.get('sessionId')) || usageHistory[0];
    return [0, 1, 2, 3].map((index) => ({ ...entry, timestamp: new Date(new Date(entry.timestamp).getTime() + index * 60000).toISOString(), inputTokens: 3200 + index * 1100, outputTokens: 780 + index * 280, cacheReadTokens: 1200, cacheWriteTokens: 300, totalTokens: 5480 + index * 1380, costUsd: 0.025 + index * 0.01, messageId: `design-message-${index + 1}`, eventId: `design-event-${index + 1}` }));
  }
  if (path === '/api/account/session') {
    if (scene === 'auth-offline') return httpError('离线示例：账号服务不可用');
    if (scene.startsWith('account-')) return { state: 'authenticated', user, expiresAt: null };
  }
  if (path === '/api/account/public-settings' && scene.startsWith('auth-')) return {
    ...publicSettings, registrationEnabled: scene !== 'auth-registration-closed',
    emailVerifyEnabled: scene !== 'auth-register',
  };
  if (path === '/api/account/login') {
    if (scene === 'auth-login-error') return httpError('邮箱或密码不正确，请检查后重试', 401);
    if (scene.startsWith('auth-two-factor')) return { state: 'requires2FA', tempToken: 'design-only-2fa-challenge', userEmailMasked: 'd***@example.test' };
    return { user, expiresAt: null };
  }
  if (path === '/api/account/login/2fa') return scene === 'auth-two-factor-error' ? httpError('验证码不正确，请重新输入', 401) : { state: 'authenticated', user, expiresAt: null };
  if (path === '/api/account/register') return scene === 'auth-register-error' ? httpError('这个邮箱已注册，请直接登录', 409) : { state: 'authenticated', user, expiresAt: null };
  if (path === '/api/account/send-verify-code') return scene === 'auth-verify-code-error' ? httpError('验证码发送过于频繁，请稍后重试', 429) : { message: '验证码已发送，请查收邮件', countdown: 60 };
  if (path === '/api/account/refresh') return { state: 'authenticated', user, expiresAt: null };
  if (path === '/api/account/logout') return { success: true };
  if (path === '/api/subscription/summary') return noSubscription ? { activeCount: 0, totalUsedUsd: 0, subscriptions: [] } : subscriptionSummary;
  if (path === '/api/subscription/active') return noSubscription ? [] : activeSubscriptions;
  if (path === '/api/subscription/progress') return noSubscription ? [] : progress;
  if (path === '/api/subscription/platform-quotas') return noSubscription ? [] : ['OpenAI', 'Anthropic', 'Google'].map((platform, index) => ({ platform, daily: { usedUsd: 2 + index, limitUsd: 30, resetsAt: iso(1) }, weekly: { usedUsd: 12 + index, limitUsd: 180, resetsAt: iso(4) }, monthly: { usedUsd: 42 + index, limitUsd: 600, resetsAt: iso(23) }, updatedAt: iso() }));
  if (path === '/api/billing/plans') return scene === 'account-plans-empty' ? [] : plans;
  if (path === '/api/billing/checkout-info') {
    if (scene === 'account-checkout-error') return httpError('离线示例：套餐服务暂时不可用');
    return { ...checkoutInfo, ...(scene === 'account-plans-empty' ? { plans: [] } : {}), ...(scene === 'account-payment-unavailable' ? { methods: {} } : {}) };
  }
  if (path === '/api/billing/orders') {
    const plan = plans.find((item) => item.id === body?.planId) || plans[0];
    state.order = { id: 2026102201, userId: 1, amount: plan.price, payAmount: plan.price, currency: 'CNY', feeRate: 0, paymentType: body?.paymentType || 'alipay', outTradeNo: 'DESIGN-ONLY-20261022-001', status: 'pending', orderType: 'subscription', createdAt: iso(), expiresAt: new Date(now + 900000).toISOString(), refundAmount: 0, planId: plan.id };
    return { orderId: state.order.id, amount: state.order.amount, payAmount: state.order.payAmount, feeRate: 0, currency: 'CNY', expiresAt: state.order.expiresAt, paymentType: state.order.paymentType, outTradeNo: state.order.outTradeNo, resultType: 'order_created', payUrl: 'https://payment.example.test/design-only', qrCode: '离线设计示例 · 非付款码\nDESIGN-ONLY-20261022-001' };
  }
  if (path === '/api/billing/orders/verify' || /^\/api\/billing\/orders\/\d+$/.test(path)) {
    if (!state.order) return httpError('演示订单不存在', 404);
    const status = ['pending', 'recharging', 'completed', 'expired', 'failed', 'cancelled'].find((item) => scene === `account-order-${item}`) || 'pending';
    return { ...state.order, status, ...(status === 'completed' ? { paidAt: iso(), completedAt: iso() } : {}) };
  }
  return undefined;
}

export function accountProvidersIpc(channel, args, context = {}) {
  const input = args[0];
  if (channel === 'providers:startOAuth') {
    setTimeout(() => {
      const error = context.scenarioId === 'providers-oauth-error';
      const manual = context.scenarioId === 'providers-oauth-manual';
      const payload = manual
        ? { mode: 'manual', authorizationUrl: 'https://auth.example.test/design-only', message: '打开授权页面并登录，然后粘贴回调链接或授权码。此页面为离线示例。' }
        : { mode: 'device', verificationUri: 'https://auth.example.test/device', userCode: 'DEMO-2026', expiresIn: 600 };
      window.__designEmit('host:event', { eventName: error ? 'oauth:error' : 'oauth:code', payload: error ? { message: '演示授权已过期，请重试。' } : payload });
    }, 25);
    return { flowId: input.flowId, status: 'started' };
  }
  if (channel === 'providers:cancelOAuth') return { flowId: input.flowId, status: 'cancelled' };
  if (channel === 'providers:submitOAuthCode') return { flowId: input.flowId, status: 'submitted' };
  if (channel === 'providers:storeAccount') {
    const state = stateFor(context);
    const account = structuredClone(input.account);
    const index = state.accounts.findIndex((item) => item.id === account.id);
    if (index < 0) state.accounts.push(account); else state.accounts[index] = account;
    return providerCall(state, 'providerAccounts.replace', 'replaceAccount', { accountId: account.id, accountRevision: account.revision });
  }
  if (channel === 'providers:deleteAccount') {
    const state = stateFor(context);
    state.accounts = state.accounts.filter((account) => account.id !== input.accountId);
    state.models = state.models.filter((model) => model.accountId !== input.accountId);
    return providerCall(state, 'providerAccounts.delete', 'deleteAccount', { outcome: 'deleted', accountId: input.accountId, accountRevision: input.revision });
  }
  return undefined;
}

const providerSources = ['src/plugins/providers/page/index.tsx', 'src/plugins/providers/components/ProvidersSettings.tsx', 'src/plugins/providers/components/ProviderCredentialModelsEditor.tsx'];
const routeSources = ['src/plugins/providers/components/MediaCapabilitiesPanel.tsx', 'src/plugins/providers/services/capability-routing.ts'];
const accountSources = ['src/plugins/account/AccountFooter.tsx', 'src/plugins/account/billing/SubscriptionPlanDialog.tsx', 'src/plugins/account/api/subscription.ts', 'src/plugins/account/api/billing.ts'];
const dashboardSources = ['src/plugins/dashboard/pages/index.tsx', 'src/plugins/dashboard/pages/usage-history.ts', 'src/plugins/dashboard/stores/dashboard-usage.ts'];
const authSources = ['src/plugins/account/pages/Auth/index.tsx', 'src/plugins/account/stores/account.ts', 'src/plugins/account/api/account.ts'];
const button = (name, index) => ({ role: 'button', name, exact: true, ...(index === undefined ? {} : { index }) });
const providerScene = (id, title, options = {}) => ({ id: `providers-${id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, title, group: '模型', route: '/providers', sources: providerSources, ...options });
const accountScene = (id, title, prepare, options = {}) => ({ id: `account-${id}`, title, group: '账户', route: '/dashboard', sources: accountSources, prepare, ...options });
const authScene = (id, title, route = '/login', options = {}) => ({ id: `auth-${id}`, title, group: '登录', route, sources: authSources, ...options });
async function openAccount(page, id) {
  const account = accounts.find((item) => item.id === id);
  await page.getByRole('button', { name: new RegExp(account.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await page.getByRole('button', { name: '编辑 API 密钥', exact: true }).first().waitFor();
}
async function openAdd(page, vendor) {
  await page.getByRole('button', { name: '添加提供商', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 AI 提供商', exact: true });
  await dialog.waitFor();
  if (vendor) await dialog.getByRole('button').filter({ has: page.locator('p').filter({ hasText: new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).click();
  return dialog;
}
async function openSubscription(page, checkout = false) {
  await page.getByRole('button', { name: '打开账号菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '订阅服务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: '当前订阅', exact: true }).waitFor();
  if (checkout) {
    await dialog.getByRole('tab', { name: '选择套餐', exact: true }).click();
    await dialog.getByText('付款信息', { exact: true }).waitFor();
  }
  return dialog;
}
async function submitLogin(page) {
  await page.locator('#email').fill('designer@example.test');
  await page.locator('#password').fill('offline-demo-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

export const accountProvidersScenarios = [
  providerScene('overview', '模型账户 · 总览', { waitFor: 'OpenAI · 工作空间' }),
  providerScene('empty', '模型账户 · 未配置', { waitFor: '未配置提供商' }),
  providerScene('missing-key', '模型账户 · 缺少密钥', { prepare: (page) => openAccount(page, 'demo-openai'), waitFor: '未设置 API 密钥' }),
  providerScene('collapsed', '模型账户 · 收起列表', { actions: [button('模型')], waitFor: '模型分配' }),
  ...['demo-openai', 'demo-media'].map((id) => providerScene(`account-${id.slice(5)}`, `模型账户 · ${accounts.find((account) => account.id === id).label}`, { prepare: (page) => openAccount(page, id), waitFor: '模型清单' })),
  ...['demo-openai', 'demo-anthropic', 'demo-media', 'demo-oauth', 'demo-cli', 'demo-custom', 'demo-zai'].map((id) => providerScene(`edit-${id.slice(5)}`, `编辑凭证 · ${accounts.find((account) => account.id === id).label}`, { prepare: async (page) => { await openAccount(page, id); await page.getByRole('button', { name: '编辑 API 密钥', exact: true }).click(); }, waitFor: id === 'demo-cli' ? '请先登录 Claude Code。保存前会验证本机 CLI 凭据，无需粘贴令牌。' : '替换' })),
  providerScene('models-advanced', '文本模型 · 高级字段', { prepare: async (page) => { await openAccount(page, 'demo-openai'); await page.getByRole('button', { name: '高级字段', exact: true }).first().click(); }, waitFor: '上下文窗口' }),
  providerScene('media-advanced', '图像模型 · 高级字段', { prepare: async (page) => { await openAccount(page, 'demo-media'); await page.getByRole('button', { name: '高级字段', exact: true }).first().click(); }, waitFor: '清晰度' }),
  providerScene('model-new', '模型清单 · 新增草稿', { prepare: async (page) => { await openAccount(page, 'demo-openai'); await page.getByRole('button', { name: '添加模型', exact: true }).click(); await page.getByRole('textbox', { name: '模型 ID', exact: true }).last().fill('design-chat-preview'); }, waitFor: '未保存修改' }),
  ...[['discovery', '可导入模型'], ['discovery-empty', '未发现可用模型'], ['discovery-error', '后端拒绝了模型列表请求']].map(([id, waitFor]) => providerScene(id, `模型发现 · ${id === 'discovery' ? '导入列表' : id.endsWith('empty') ? '空结果' : '请求被拒绝'}`, { prepare: async (page) => { await openAccount(page, 'demo-openai'); await page.getByRole('button', { name: '获取模型', exact: true }).click(); }, waitFor })),
  providerScene('add', '新增提供商 · 品牌选择', { prepare: (page) => openAdd(page), waitFor: '添加 AI 提供商' }),
  ...[
    ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['minimax', 'MiniMax (Global)'],
    ['qwen', 'Qwen Cloud'], ['stepfun', 'StepFun'], ['ollama', 'Ollama'],
  ].map(([id, name]) => providerScene(`add-${id}`, `新增提供商 · ${name}`, { prepare: (page) => openAdd(page, name), waitFor: '显示名称' })),
  ...[['token', 'token'], ['cli', 'cli_reuse']].map(([id, mode]) => providerScene(`add-${id}`, `新增 Anthropic · ${id === 'token' ? 'Token' : '复用 CLI 登录'}`, { prepare: async (page) => { await openAdd(page, 'Anthropic'); await page.locator('#provider-auth-mode').selectOption(mode); }, waitFor: id === 'token' ? 'Token / setup-token' : '请先登录 Claude Code。保存前会验证本机 CLI 凭据，无需粘贴令牌。' })),
  ...['openai-completions', 'openai-responses', 'anthropic-messages'].map((protocol) => providerScene(`custom-${protocol}`, `自定义聊天 · ${protocol}`, { prepare: async (page) => { await openAdd(page, '自定义'); await page.locator('#provider-add-protocol').selectOption(protocol); await page.locator('#name').fill('离线兼容服务'); await page.locator('#baseUrl').fill('https://chat.example.test/v1'); }, waitFor: '聊天提供商' })),
  ...[['openai', 'OpenAI'], ['google', 'Google Gemini'], ['openrouter', 'OpenRouter']].map(([protocol, label]) => providerScene(`media-${protocol}`, `自定义媒体 · ${label}`, { sources: [...providerSources, 'src/plugins/providers/domain/custom-media-provider-contracts.ts'], prepare: async (page) => { const dialog = await openAdd(page, '自定义'); await dialog.getByRole('button', { name: '媒体提供商', exact: true }).click(); await page.locator('#provider-add-media-provider').selectOption(protocol); }, waitFor: '接口契约' })),
  providerScene('code-plan', '新增提供商 · Code Plan 端点', { prepare: async (page) => { const dialog = await openAdd(page, 'Z.AI (CN)'); await dialog.getByRole('checkbox').check(); }, waitFor: 'Code Plan 端点' }),
  ...[['device', 'oauth_device'], ['manual', 'oauth_browser'], ['error', 'oauth_device']].map(([id, mode]) => providerScene(`oauth-${id}`, `提供商授权 · ${id === 'device' ? '设备验证码' : id === 'manual' ? '粘贴回调链接' : '认证失败'}`, { prepare: async (page) => { const dialog = await openAdd(page, 'OpenAI'); await page.locator('#provider-auth-mode').selectOption(mode); await dialog.getByRole('button', { name: '浏览器登录', exact: true }).click(); }, waitFor: id === 'device' ? 'DEMO-2026' : id === 'manual' ? '提交授权码' : '认证失败' })),
  providerScene('routing', '模型分配 · 六类能力', { sources: routeSources, actions: [button('模型分配')], waitFor: '语音合成 (TTS)' }),
  ...[['chat', '聊天主模型'], ['imageUnderstand', '图像理解'], ['imageGenerate', '图像生成'], ['videoGenerate', '视频生成'], ['musicGenerate', '音乐生成'], ['tts', '语音合成 (TTS)']].map(([capability, label]) => providerScene(`routing-${capability}`, `模型分配 · ${label}高级配置`, { sources: routeSources, prepare: async (page) => { await page.getByRole('button', { name: '模型分配', exact: true }).click(); const row = page.locator(`#capability-${capability}-primary`).locator('xpath=../../..'); const expand = row.getByRole('button', { name: '高级', exact: true }); if (await expand.count()) await expand.click(); await page.locator(`#capability-${capability}-timeout`).scrollIntoViewIfNeeded(); }, waitFor: '超时（毫秒，可选）' })),
  providerScene('recovery', '模型配置 · 恢复提示', { sources: ['src/plugins/providers/components/ProviderRecoveryDialog.tsx'], waitFor: '模型配置已重置' }),
  accountScene('menu', '账户 · 全局菜单', undefined, { actions: [button('打开账号菜单')], waitFor: '订阅服务' }),
  accountScene('current', '订阅 · 当前订阅与日周月额度', (page) => openSubscription(page), { waitFor: '订阅额度' }),
  accountScene('balance', '订阅 · Free 与余额明细', (page) => openSubscription(page), { waitFor: '余额明细' }),
  accountScene('checkout', '套餐 · 全部套餐', (page) => openSubscription(page, true), { waitFor: '全部套餐' }),
  ...[['day', '天套餐'], ['week', '周套餐'], ['month', '月套餐'], ['year', '年套餐'], ['other', '其他套餐']].map(([id, label]) => accountScene(`plans-${id}`, `套餐 · ${label}`, async (page) => { const dialog = await openSubscription(page, true); await dialog.getByRole('tab', { name: label, exact: true }).click(); }, { waitFor: label })),
  accountScene('payment-wechat', '付款信息 · 微信支付', async (page) => { const dialog = await openSubscription(page, true); await dialog.getByRole('button', { name: '微信支付', exact: true }).click(); }, { waitFor: '手续费 0.6%' }),
  accountScene('payment-unavailable', '付款信息 · 无可用支付方式', (page) => openSubscription(page, true), { waitFor: '当前没有可用支付方式' }),
  accountScene('plans-empty', '套餐 · 暂无在售套餐', async (page) => { const dialog = await openSubscription(page); await dialog.getByRole('tab', { name: '选择套餐', exact: true }).click(); }, { waitFor: '暂无可购买的 Matcha 套餐。' }),
  accountScene('checkout-error', '套餐 · 加载失败', async (page) => { const dialog = await openSubscription(page); await dialog.getByRole('tab', { name: '选择套餐', exact: true }).click(); }, { waitFor: '套餐加载失败' }),
  ...[['pending', '待支付'], ['recharging', '支付处理中'], ['completed', '支付完成'], ['expired', '已过期'], ['failed', '支付失败'], ['cancelled', '已取消']].map(([status, label]) => accountScene(`order-${status}`, `账单订单 · ${label}`, async (page) => { const dialog = await openSubscription(page, true); await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /^确认支付 / }).click(); await dialog.getByText('支付状态', { exact: true }).waitFor(); if (status !== 'pending') await dialog.getByRole('button', { name: '检查支付结果', exact: true }).click(); await dialog.getByText(label, { exact: true }).waitFor(); await dialog.getByText('支付状态', { exact: true }).scrollIntoViewIfNeeded(); }, { waitFor: '支付状态' })),
  ...[['model', '按模型'], ['day', '按时间']].flatMap(([groupBy, groupLabel]) => [['7d', '7 天'], ['30d', '30 天'], ['all', '全部']].map(([window, windowLabel]) => ({ id: `dashboard-${groupBy}-${window}`, title: `Token 用量 · ${groupLabel} · ${windowLabel}`, group: '概览', route: '/dashboard', sources: dashboardSources, actions: [button(groupLabel), button(windowLabel)], waitFor: '总 token' }))),
  ...[['detail', '会话明细'], ['detail-empty', '会话明细空结果'], ['detail-error', '会话明细读取失败']].map(([id, label]) => ({ id: `dashboard-${id}`, title: `Token 用量 · ${label}`, group: '概览', route: '/dashboard', sources: dashboardSources, actions: [button('展开 session 明细', 0)], waitFor: id === 'detail' ? '收起 session 明细' : id === 'detail-empty' ? '这个 session 没有 token 明细' : '会话用量明细暂时不可用' })),
  { id: 'dashboard-page-two', title: 'Token 用量 · 第二页', group: '概览', route: '/dashboard', sources: dashboardSources, actions: [button('下一页')], waitFor: '第 2 /' },
  { id: 'dashboard-empty', title: 'Token 用量 · 空状态', group: '概览', route: '/dashboard', sources: dashboardSources, waitFor: '还没有 token 消耗历史' },
  { id: 'dashboard-error', title: 'Token 用量 · 读取失败', group: '概览', route: '/dashboard', sources: dashboardSources, waitFor: '用量数据暂时不可用' },
  authScene('login', '登录 · 邮箱密码', '/login', { waitFor: '本地进入' }),
  authScene('register', '注册 · 邮箱密码', '/register', { waitFor: '创建账号' }),
  authScene('email-verify', '注册 · 邮箱验证码', '/register', { waitFor: '发送验证码' }),
  authScene('verify-code-sent', '注册 · 验证码已发送', '/register', { actions: [{ css: '#email', fill: 'designer@example.test' }, button('发送验证码')], waitFor: '验证码已发送，请查收邮件' }),
  authScene('verify-code-error', '注册 · 验证码发送失败', '/register', { actions: [{ css: '#email', fill: 'designer@example.test' }, button('发送验证码')], waitFor: '验证码发送过于频繁' }),
  authScene('registration-closed', '注册 · 暂未开放', '/register', { waitFor: '当前暂未开放注册，已有账号可直接登录' }),
  authScene('two-factor', '登录 · 双重验证', '/login', { prepare: submitLogin, waitFor: '请输入身份验证器中的验证码以完成登录' }),
  authScene('two-factor-error', '登录 · 双重验证失败', '/login', { prepare: async (page) => { await submitLogin(page); await page.locator('#two-factor-code').fill('000000'); await page.getByRole('button', { name: '验证并登录', exact: true }).click(); }, waitFor: '验证码不正确，请重新输入' }),
  authScene('login-error', '登录 · 凭据错误', '/login', { prepare: submitLogin, waitFor: '邮箱或密码不正确' }),
  authScene('register-error', '注册 · 邮箱已注册', '/register', { prepare: async (page) => { await page.locator('#email').fill('designer@example.test'); await page.locator('#password').fill('offline-demo-password'); await page.locator('#verify-code').fill('123456'); await page.getByRole('button', { name: '注册', exact: true }).click(); }, waitFor: '这个邮箱已注册' }),
  authScene('offline', '登录 · 账号服务离线', '/login', { waitFor: '离线进入' }),
];
