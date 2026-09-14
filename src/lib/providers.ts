/**
 * Provider Types & UI Metadata — single source of truth for the frontend.
 *
 * Credentials, model catalog entries, and capability routing are separate data
 * surfaces. Provider metadata only describes vendors and authentication.
 */

export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ark',
  'zai',
  'zai-global',
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'deepseek',
  'minimax-portal',
  'minimax-portal-cn',
  'qwen-portal',
  'qianfan',
  'stepfun',
  'tencent-tokenhub',
  'tencent-tokenplan',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen',
  'qwen-token-plan',
  'kimi',
  'volcengine-plan',
  'opencode',
  'opencode-go',
  'github-copilot',
  'ollama',
  'custom',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const BUILTIN_PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ark',
  'zai',
  'zai-global',
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'deepseek',
  'minimax-portal',
  'minimax-portal-cn',
  'qwen-portal',
  'qianfan',
  'stepfun',
  'tencent-tokenhub',
  'tencent-tokenplan',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen',
  'qwen-token-plan',
  'kimi',
  'volcengine-plan',
  'opencode',
  'opencode-go',
  'github-copilot',
  'ollama',
] as const;

export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama-local';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  providerKind?: ProviderCredentialKind;
  baseUrl?: string;
  apiProtocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  mediaApiProtocol?: CustomMediaApiProtocol;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderWithKeyInfo extends ProviderConfig {
  hasKey: boolean;
  keyMasked: string | null;
}

export interface ProviderTypeInfo {
  id: ProviderType;
  brandId?: ProviderType;
  apiProtocol?: ProviderConfig['apiProtocol'];
  endpointPresets?: readonly { id: string; label: string; baseUrl: string }[];
  name: string;
  icon: string;
  placeholder: string;
  model?: string;
  modelCapabilities?: ModelCapability[];
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  codePlan?: {
    baseUrl?: string;
    modelId: string;
  };
  runtimeProviderKey?: string;
  isOAuth?: boolean;
  supportsApiKey?: boolean;
  hideOAuthUi?: boolean;
  apiKeyUrl?: string;
  docsUrl?: string;
  docsUrlZh?: string;
}

export type ProviderAuthMode =
  | 'api_key'
  | 'oauth_device'
  | 'oauth_browser'
  | 'token'
  | 'cli_reuse'
  | 'local';

export type ProviderOAuthMode = Extract<ProviderAuthMode, 'oauth_browser' | 'oauth_device'>;

export type ProviderVendorCategory =
  | 'official'
  | 'compatible'
  | 'local'
  | 'custom';

export type ProviderCredentialKind = 'chat' | 'media';

export type CustomMediaCapability =
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts'
  | 'transcribe';

export type CustomMediaApiProtocol =
  | 'openai'
  | 'google'
  | 'openrouter';

export interface ProviderVendorInfo extends ProviderTypeInfo {
  category: ProviderVendorCategory;
  envVar?: string;
  supportedAuthModes: ProviderAuthMode[];
  defaultAuthMode: ProviderAuthMode;
  supportsMultipleAccounts: boolean;
}

export interface ProviderCredential {
  id: string;
  vendorId: ProviderType;
  providerKind?: ProviderCredentialKind;
  label: string;
  authMode: ProviderAuthMode;
  baseUrl?: string;
  apiProtocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  mediaApiProtocol?: CustomMediaApiProtocol;
  headers?: Record<string, string>;
  enabled: boolean;
  metadata?: {
    region?: string;
    email?: string;
    resourceUrl?: string;
    customModels?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export type ModelCapability =
  | 'chat'
  | 'imageUnderstand'
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts'
  | 'transcribe';

import { providerIcons } from '@/assets/providers';

/** All supported provider types with UI metadata */
export const PROVIDER_TYPE_INFO: ProviderTypeInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🤖',
    placeholder: 'sk-ant-api03-...',
    model: 'Claude',
    requiresApiKey: true,
    supportsApiKey: true,
    apiProtocol: 'anthropic-messages',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '💚',
    placeholder: 'sk-proj-...',
    model: 'GPT',
    requiresApiKey: true,
    isOAuth: true,
    supportsApiKey: true,
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    name: 'Google',
    icon: '🔷',
    placeholder: 'AIza...',
    model: 'Gemini',
    requiresApiKey: true,
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  { id: 'openrouter', name: 'OpenRouter', icon: '🌐', placeholder: 'sk-or-v1-...', model: 'Multi-Model', requiresApiKey: true, isOAuth: true, supportsApiKey: true, defaultBaseUrl: 'https://openrouter.ai/api/v1', apiProtocol: 'openai-completions', docsUrl: 'https://openrouter.ai/models' },
  {
    id: 'ark',
    name: 'ByteDance Ark',
    icon: 'A',
    placeholder: 'your-ark-api-key',
    model: 'Doubao',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    showBaseUrl: true,
    codePlan: { modelId: 'ark-code-latest' },
    docsUrl: 'https://www.volcengine.com/',
  },
  {
    id: 'zai',
    name: 'Z.AI (CN)',
    icon: 'Z',
    placeholder: 'zai-...',
    model: 'glm-5.2',
    modelCapabilities: ['chat', 'imageUnderstand'],
    requiresApiKey: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    showBaseUrl: true,
    codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
    runtimeProviderKey: 'zai',
    apiKeyUrl: 'https://open.bigmodel.cn/user/apiKeys',
    docsUrl: 'https://open.bigmodel.cn/dev/api/llm-models',
  },
  {
    id: 'zai-global',
    brandId: 'zai',
    name: 'Z.AI (Global)',
    icon: 'Z',
    placeholder: 'zai-...',
    model: 'glm-5.2',
    modelCapabilities: ['chat', 'imageUnderstand'],
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    showBaseUrl: true,
    codePlan: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-5.2' },
    runtimeProviderKey: 'zai',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/',
  },
  { id: 'moonshot', name: 'Moonshot (CN)', icon: '🌙', placeholder: 'sk-...', model: 'Kimi', requiresApiKey: true, defaultBaseUrl: 'https://api.moonshot.cn/v1', docsUrl: 'https://platform.moonshot.cn/' },
  { id: 'moonshot-global', brandId: 'moonshot', name: 'Moonshot (Global)', icon: '🌙', placeholder: 'sk-...', model: 'Kimi', requiresApiKey: true, defaultBaseUrl: 'https://api.moonshot.ai/v1', docsUrl: 'https://platform.moonshot.ai/' },
  { id: 'siliconflow', name: 'SiliconFlow (CN)', icon: '🌊', placeholder: 'sk-...', model: 'Multi-Model', requiresApiKey: true, defaultBaseUrl: 'https://api.siliconflow.cn/v1', docsUrl: 'https://docs.siliconflow.cn/cn/userguide/introduction' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🐋', placeholder: 'sk-...', model: 'DeepSeek', requiresApiKey: true, defaultBaseUrl: 'https://api.deepseek.com/v1', apiKeyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/', docsUrlZh: 'https://api-docs.deepseek.com/zh-cn/' },
  { id: 'minimax-portal', name: 'MiniMax (Global)', icon: '☁️', placeholder: 'sk-...', model: 'MiniMax', requiresApiKey: false, isOAuth: true, supportsApiKey: true, apiKeyUrl: 'https://platform.minimax.io' },
  { id: 'minimax-portal-cn', brandId: 'minimax-portal', name: 'MiniMax (CN)', icon: '☁️', placeholder: 'sk-...', model: 'MiniMax', requiresApiKey: false, isOAuth: true, supportsApiKey: true, apiKeyUrl: 'https://platform.minimaxi.com/' },
  { id: 'qwen-portal', brandId: 'qwen', name: 'Qwen (Global)', icon: '☁️', placeholder: 'sk-...', model: 'Qwen', requiresApiKey: false, isOAuth: true },
  {
    id: 'qianfan', name: 'Baidu Qianfan', icon: 'Q', placeholder: 'bce-v3/...',
    model: 'deepseek-v4-pro', requiresApiKey: true,
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2', apiProtocol: 'openai-completions',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan/',
  },
  {
    id: 'stepfun', name: 'StepFun', icon: 'S', placeholder: 'step-...',
    model: 'step-3.7-flash', requiresApiKey: true, showBaseUrl: true,
    defaultBaseUrl: 'https://api.stepfun.com/v1', apiProtocol: 'openai-completions',
    endpointPresets: [
      { id: 'cn', label: 'China', baseUrl: 'https://api.stepfun.com/v1' },
      { id: 'global', label: 'Global', baseUrl: 'https://api.stepfun.ai/v1' },
    ],
    docsUrl: 'https://platform.stepfun.com/docs',
  },
  {
    id: 'tencent-tokenhub', name: 'Tencent TokenHub', icon: 'T', placeholder: 'API key...',
    model: 'hy3', requiresApiKey: true,
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1', apiProtocol: 'openai-completions',
    docsUrl: 'https://cloud.tencent.com/document/product/1772',
  },
  {
    id: 'tencent-tokenplan', brandId: 'tencent-tokenhub', name: 'Tencent Token Plan', icon: 'T', placeholder: 'API key...',
    model: 'hy3', requiresApiKey: true,
    defaultBaseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3', apiProtocol: 'openai-completions',
    docsUrl: 'https://cloud.tencent.com/document/product/1772',
  },
  {
    id: 'xiaomi', name: 'Xiaomi MiMo', icon: 'M', placeholder: 'sk-...',
    model: 'mimo-v2.5-pro', requiresApiKey: true,
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1', apiProtocol: 'openai-completions',
    docsUrl: 'https://platform.xiaomimimo.com/',
  },
  {
    id: 'xiaomi-token-plan', brandId: 'xiaomi', name: 'MiMo Token Plan', icon: 'M', placeholder: 'API key...',
    model: 'mimo-v2.5-pro', requiresApiKey: true, showBaseUrl: true,
    defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiProtocol: 'openai-completions',
    endpointPresets: [
      { id: 'cn', label: 'China', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
      { id: 'sgp', label: 'Singapore', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' },
      { id: 'ams', label: 'Amsterdam', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1' },
    ],
    docsUrl: 'https://platform.xiaomimimo.com/',
  },
  {
    id: 'qwen', name: 'Qwen Cloud', icon: 'Q', placeholder: 'sk-...',
    model: 'qwen3.6-plus', requiresApiKey: true, showBaseUrl: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiProtocol: 'openai-completions',
    endpointPresets: [
      { id: 'standard-cn', label: 'Standard China', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'standard-global', label: 'Standard Global', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { id: 'coding-cn', label: 'Coding Plan China', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
      { id: 'coding-global', label: 'Coding Plan Global', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
    ],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
  },
  {
    id: 'qwen-token-plan', brandId: 'qwen', name: 'Qwen Token Plan', icon: 'Q', placeholder: 'sk-sp-...',
    model: 'qwen3.7-plus', requiresApiKey: true, showBaseUrl: true,
    defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiProtocol: 'openai-completions',
    endpointPresets: [
      { id: 'cn', label: 'China', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
      { id: 'global', label: 'Global', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
    ],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
  },
  {
    id: 'kimi', brandId: 'moonshot', name: 'Kimi Code', icon: 'K', placeholder: 'sk-...',
    model: 'kimi-for-coding', requiresApiKey: true,
    defaultBaseUrl: 'https://api.kimi.com/coding/', apiProtocol: 'anthropic-messages',
    docsUrl: 'https://www.kimi.com/code',
  },
  {
    id: 'volcengine-plan', brandId: 'ark', name: 'Volcengine Coding Plan', icon: 'A', placeholder: 'API key...',
    model: 'ark-code-latest', requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', apiProtocol: 'openai-completions',
    docsUrl: 'https://www.volcengine.com/',
  },
  {
    id: 'opencode', name: 'OpenCode Zen', icon: 'O', placeholder: 'API key...',
    model: 'gpt-5.6-sol', requiresApiKey: true,
    defaultBaseUrl: 'https://opencode.ai/zen/v1', apiProtocol: 'openai-completions',
    apiKeyUrl: 'https://opencode.ai/auth', docsUrl: 'https://opencode.ai/docs/zen/',
  },
  {
    id: 'opencode-go', brandId: 'opencode', name: 'OpenCode Go', icon: 'O', placeholder: 'API key...',
    model: 'deepseek-v4-pro', requiresApiKey: true,
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1', apiProtocol: 'openai-completions',
    apiKeyUrl: 'https://opencode.ai/auth', docsUrl: 'https://opencode.ai/docs/go/',
  },
  {
    id: 'github-copilot', name: 'GitHub Copilot', icon: 'G', placeholder: 'Sign in with GitHub',
    model: 'gpt-5.4', requiresApiKey: false, isOAuth: true,
    defaultBaseUrl: 'https://api.individual.githubcopilot.com', apiProtocol: 'openai-responses',
    docsUrl: 'https://docs.github.com/en/copilot',
  },
  { id: 'ollama', name: 'Ollama', icon: '🦙', placeholder: 'Not required', requiresApiKey: false, defaultBaseUrl: 'http://localhost:11434/v1', showBaseUrl: true },
  {
    id: 'custom',
    name: 'Custom',
    icon: '⚙️',
    placeholder: 'API key...',
    requiresApiKey: true,
    showBaseUrl: true,
    docsUrl: 'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#Ee1ldfvKJoVGvfxc32mcILwenth',
    docsUrlZh: 'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#IWQCdfe5fobGU3xf3UGcgbLynGh',
  },
];

/** Get the SVG logo URL for a provider type, falls back to undefined */
export function getProviderIconUrl(type: ProviderType | string): string | undefined {
  return providerIcons[type];
}

/** Whether a provider's logo needs CSS invert in dark mode (all logos are monochrome) */
export function shouldInvertInDark(_type: ProviderType | string): boolean {
  return true;
}

/** Provider list shown in the Setup wizard */
export const SETUP_PROVIDERS = PROVIDER_TYPE_INFO;

/** Get type info by provider type id */
export function getProviderTypeInfo(type: ProviderType): ProviderTypeInfo | undefined {
  return PROVIDER_TYPE_INFO.find((t) => t.id === type);
}

export function getProviderDocsUrl(
  provider: Pick<ProviderTypeInfo, 'docsUrl' | 'docsUrlZh'> | undefined,
  language: string,
): string | undefined {
  if (!provider?.docsUrl) {
    return undefined;
  }
  if (language.startsWith('zh') && provider.docsUrlZh) {
    return provider.docsUrlZh;
  }
  return provider.docsUrl;
}

export function normalizeProviderApiKeyInput(apiKey: string): string {
  return apiKey.trim();
}

/** Normalize provider API key before saving; Ollama uses a local placeholder when blank. */
export function resolveProviderApiKeyForSave(type: ProviderType | string, apiKey: string): string | undefined {
  const trimmed = normalizeProviderApiKeyInput(apiKey);
  if (type === 'ollama') {
    return trimmed || OLLAMA_PLACEHOLDER_API_KEY;
  }
  return trimmed || undefined;
}
