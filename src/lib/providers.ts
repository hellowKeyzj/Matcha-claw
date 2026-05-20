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
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'deepseek',
  'minimax-portal',
  'minimax-portal-cn',
  'qwen-portal',
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
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'deepseek',
  'minimax-portal',
  'minimax-portal-cn',
  'qwen-portal',
  'ollama',
] as const;

export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama-local';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  providerKind?: ProviderCredentialKind;
  baseUrl?: string;
  apiProtocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
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
  name: string;
  icon: string;
  placeholder: string;
  model?: string;
  modelCapabilities?: ModelCapability[];
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  isOAuth?: boolean;
  supportsApiKey?: boolean;
  apiKeyUrl?: string;
  docsUrl?: string;
  docsUrlZh?: string;
}

export type ProviderAuthMode =
  | 'api_key'
  | 'oauth_device'
  | 'oauth_browser'
  | 'local';

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
  apiProtocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
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
    isOAuth: true,
    supportsApiKey: true,
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  { id: 'openrouter', name: 'OpenRouter', icon: '🌐', placeholder: 'sk-or-v1-...', model: 'Multi-Model', requiresApiKey: true, docsUrl: 'https://openrouter.ai/models' },
  {
    id: 'ark',
    name: 'ByteDance Ark',
    icon: 'A',
    placeholder: 'your-ark-api-key',
    model: 'Doubao',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    showBaseUrl: true,
    docsUrl: 'https://www.volcengine.com/',
  },
  { id: 'moonshot', name: 'Moonshot (CN)', icon: '🌙', placeholder: 'sk-...', model: 'Kimi', requiresApiKey: true, defaultBaseUrl: 'https://api.moonshot.cn/v1', docsUrl: 'https://platform.moonshot.cn/' },
  { id: 'moonshot-global', name: 'Moonshot (Global)', icon: '🌙', placeholder: 'sk-...', model: 'Kimi', requiresApiKey: true, defaultBaseUrl: 'https://api.moonshot.ai/v1', docsUrl: 'https://platform.moonshot.ai/' },
  { id: 'siliconflow', name: 'SiliconFlow (CN)', icon: '🌊', placeholder: 'sk-...', model: 'Multi-Model', requiresApiKey: true, defaultBaseUrl: 'https://api.siliconflow.cn/v1', docsUrl: 'https://docs.siliconflow.cn/cn/userguide/introduction' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🐋', placeholder: 'sk-...', model: 'DeepSeek', requiresApiKey: true, defaultBaseUrl: 'https://api.deepseek.com/v1', apiKeyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/', docsUrlZh: 'https://api-docs.deepseek.com/zh-cn/' },
  { id: 'minimax-portal', name: 'MiniMax (Global)', icon: '☁️', placeholder: 'sk-...', model: 'MiniMax', requiresApiKey: false, isOAuth: true, supportsApiKey: true, apiKeyUrl: 'https://platform.minimax.io' },
  { id: 'minimax-portal-cn', name: 'MiniMax (CN)', icon: '☁️', placeholder: 'sk-...', model: 'MiniMax', requiresApiKey: false, isOAuth: true, supportsApiKey: true, apiKeyUrl: 'https://platform.minimaxi.com/' },
  { id: 'qwen-portal', name: 'Qwen (Global)', icon: '☁️', placeholder: 'sk-...', model: 'Qwen', requiresApiKey: false, isOAuth: true },
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
