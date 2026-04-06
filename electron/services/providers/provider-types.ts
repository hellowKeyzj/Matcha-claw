export const BUILTIN_PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ark',
  'moonshot',
  'siliconflow',
  'minimax-portal',
  'minimax-portal-cn',
  'qwen-portal',
  'ollama',
] as const;

export type ProviderType = string;

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  model?: string;
  fallbackModels?: string[];
  fallbackProviderIds?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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

