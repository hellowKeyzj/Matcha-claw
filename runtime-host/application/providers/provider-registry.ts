import type {
  ModelCapability,
  ProviderBackendConfig,
  ProviderDefinition,
  ProviderType,
  ProviderTypeInfo,
} from './provider-types';
import { resolveProviderModelCapabilities } from './provider-model-capabilities';

const EXTRA_ENV_ONLY_PROVIDERS: Record<string, { envVar: string }> = {
  groq: { envVar: 'GROQ_API_KEY' },
  deepgram: { envVar: 'DEEPGRAM_API_KEY' },
  cerebras: { envVar: 'CEREBRAS_API_KEY' },
  xai: { envVar: 'XAI_API_KEY' },
  mistral: { envVar: 'MISTRAL_API_KEY' },
};

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🤖',
    placeholder: 'sk-ant-api03-...',
    model: 'Claude',
    requiresApiKey: true,
    category: 'official',
    envVar: 'ANTHROPIC_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '💚',
    placeholder: 'sk-proj-...',
    model: 'GPT',
    requiresApiKey: true,
    category: 'official',
    envVar: 'OPENAI_API_KEY',
    isOAuth: true,
    supportsApiKey: true,
    supportedAuthModes: ['api_key', 'oauth_browser'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-responses',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
  },
  {
    id: 'google',
    name: 'Google',
    icon: '🔷',
    placeholder: 'AIza...',
    model: 'Gemini',
    requiresApiKey: true,
    category: 'official',
    envVar: 'GEMINI_API_KEY',
    isOAuth: true,
    supportsApiKey: true,
    supportedAuthModes: ['api_key', 'oauth_browser'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🌐',
    placeholder: 'sk-or-v1-...',
    model: 'Multi-Model',
    requiresApiKey: true,
    category: 'compatible',
    envVar: 'OPENROUTER_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      headers: {
        'HTTP-Referer': 'https://matchaclaw-x.com',
        'X-OpenRouter-Title': 'MatchaClaw',
      },
    },
  },
  {
    id: 'ark',
    name: 'ByteDance Ark',
    icon: 'A',
    placeholder: 'your-ark-api-key',
    model: 'Doubao',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    showBaseUrl: true,
    category: 'official',
    envVar: 'ARK_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      api: 'openai-completions',
      apiKeyEnv: 'ARK_API_KEY',
    },
  },
  {
    id: 'moonshot',
    name: 'Moonshot (CN)',
    icon: '🌙',
    placeholder: 'sk-...',
    model: 'Kimi',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    category: 'official',
    envVar: 'MOONSHOT_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
      apiKeyEnv: 'MOONSHOT_API_KEY',
    },
  },
  {
    id: 'moonshot-global',
    name: 'Moonshot (Global)',
    icon: '🌙',
    placeholder: 'sk-...',
    model: 'Kimi',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    category: 'official',
    envVar: 'MOONSHOT_GLOBAL_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.moonshot.ai/v1',
      api: 'openai-completions',
      apiKeyEnv: 'MOONSHOT_GLOBAL_API_KEY',
    },
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (CN)',
    icon: '🌊',
    placeholder: 'sk-...',
    model: 'Multi-Model',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    category: 'compatible',
    envVar: 'SILICONFLOW_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      api: 'openai-completions',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🐋',
    placeholder: 'sk-...',
    model: 'DeepSeek',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    category: 'official',
    envVar: 'DEEPSEEK_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  {
    id: 'minimax-portal',
    name: 'MiniMax (Global)',
    icon: '☁️',
    placeholder: 'sk-...',
    model: 'MiniMax',
    requiresApiKey: false,
    isOAuth: true,
    supportsApiKey: true,
    apiKeyUrl: 'https://platform.minimax.io',
    category: 'official',
    envVar: 'MINIMAX_API_KEY',
    supportedAuthModes: ['oauth_device', 'api_key'],
    defaultAuthMode: 'oauth_device',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'MINIMAX_API_KEY',
    },
  },
  {
    id: 'minimax-portal-cn',
    name: 'MiniMax (CN)',
    icon: '☁️',
    placeholder: 'sk-...',
    model: 'MiniMax',
    requiresApiKey: false,
    isOAuth: true,
    supportsApiKey: true,
    apiKeyUrl: 'https://platform.minimaxi.com/',
    category: 'official',
    envVar: 'MINIMAX_CN_API_KEY',
    supportedAuthModes: ['oauth_device', 'api_key'],
    defaultAuthMode: 'oauth_device',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://api.minimaxi.com/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'MINIMAX_CN_API_KEY',
    },
  },
  {
    id: 'qwen-portal',
    name: 'Qwen',
    icon: '☁️',
    placeholder: 'sk-...',
    model: 'Qwen',
    requiresApiKey: false,
    isOAuth: true,
    category: 'official',
    envVar: 'QWEN_API_KEY',
    supportedAuthModes: ['oauth_device'],
    defaultAuthMode: 'oauth_device',
    supportsMultipleAccounts: true,
    providerConfig: {
      baseUrl: 'https://portal.qwen.ai/v1',
      api: 'openai-completions',
      apiKeyEnv: 'QWEN_API_KEY',
    },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    placeholder: 'Not required',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    showBaseUrl: true,
    category: 'local',
    supportedAuthModes: ['local'],
    defaultAuthMode: 'local',
    supportsMultipleAccounts: true,
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: '⚙️',
    placeholder: 'API key...',
    requiresApiKey: true,
    showBaseUrl: true,
    category: 'custom',
    envVar: 'CUSTOM_API_KEY',
    supportedAuthModes: ['api_key'],
    defaultAuthMode: 'api_key',
    supportsMultipleAccounts: true,
  },
];

export const PROVIDER_VENDOR_DEFINITIONS = PROVIDER_DEFINITIONS;

const PROVIDER_DEFINITION_MAP = new Map(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getProviderDefinition(
  type: ProviderType | string,
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITION_MAP.get(type as ProviderType);
}

export function getProviderTypeInfo(
  type: ProviderType,
): ProviderTypeInfo | undefined {
  return getProviderDefinition(type);
}

export function getProviderEnvVar(type: string): string | undefined {
  return getProviderDefinition(type)?.envVar ?? EXTRA_ENV_ONLY_PROVIDERS[type]?.envVar;
}

export function getProviderBackendConfig(
  type: string,
): ProviderBackendConfig | undefined {
  return getProviderDefinition(type)?.providerConfig;
}

export function getProviderConfig(
  type: string,
): { baseUrl: string; api: string; apiKeyEnv: string; headers?: Record<string, string> } | undefined {
  return getProviderBackendConfig(type) as ProviderBackendConfig | undefined;
}

export function getProviderEnvVars(type: string): string[] {
  const envVar = getProviderEnvVar(type);
  return envVar ? [envVar] : [];
}

export function getProviderUiInfoList(): ProviderTypeInfo[] {
  return PROVIDER_VENDOR_DEFINITIONS;
}

export function getKeyableProviderTypes(): string[] {
  return [
    ...PROVIDER_DEFINITIONS.filter((definition) => definition.envVar).map(
      (definition) => definition.id,
    ),
    ...Object.keys(EXTRA_ENV_ONLY_PROVIDERS),
  ];
}

export function getProviderModelCapabilities(type: ProviderType): ModelCapability[] {
  return resolveProviderModelCapabilities({ vendorId: type });
}
