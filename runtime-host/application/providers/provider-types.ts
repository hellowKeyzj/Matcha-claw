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

export type ProviderType = (typeof PROVIDER_TYPES)[number];
export type BuiltinProviderType = (typeof BUILTIN_PROVIDER_TYPES)[number];

export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama-local';

export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'google-generative-ai'
  | 'anthropic-messages'
  | 'openrouter';

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

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
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
}

export interface ProviderBackendConfig {
  baseUrl: string;
  api: ProviderProtocol;
  apiKeyEnv: string;
  headers?: Record<string, string>;
}

export interface ProviderDefinition extends ProviderTypeInfo {
  category: ProviderVendorCategory;
  envVar?: string;
  providerConfig?: ProviderBackendConfig;
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
  apiProtocol?: ProviderProtocol;
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

export interface ProviderModel {
  credentialId: string;
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}

export interface ModelRef {
  credentialId: string;
  modelId: string;
}

export interface ModelRoute {
  primary: ModelRef;
  fallbacks: ModelRef[];
  timeoutMs?: number;
}

export interface CapabilityRouting {
  chat?: ModelRoute;
  imageUnderstand?: ModelRoute;
  imageGenerate?: ModelRoute;
  videoGenerate?: ModelRoute;
  musicGenerate?: ModelRoute;
  tts?: ModelRoute;
}

export type ProviderSecret =
  | {
      type: 'api_key';
      accountId: string;
      apiKey: string;
    }
  | {
      type: 'oauth';
      accountId: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scopes?: string[];
      email?: string;
      subject?: string;
    }
  | {
      type: 'local';
      accountId: string;
      apiKey?: string;
    };

export interface ModelSummary {
  id: string;
  name: string;
  vendorId: string;
  accountId?: string;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  source: 'builtin' | 'remote' | 'gateway' | 'custom';
}
