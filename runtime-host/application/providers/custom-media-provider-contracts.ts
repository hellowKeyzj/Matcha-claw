import type {
  CustomMediaCapability,
  CustomMediaApiProtocol,
  ProviderProtocol,
} from './provider-types';

export type {
  CustomMediaCapability,
  CustomMediaApiProtocol,
};

export type CustomMediaContract = {
  readonly id: CustomMediaApiProtocol;
  readonly label: string;
  readonly runtimeApiProtocol: ProviderProtocol;
  readonly capabilities: readonly CustomMediaCapability[];
  readonly defaultBaseUrl?: string;
  readonly defaultModelByCapability: Partial<Record<CustomMediaCapability, string>>;
};

export const CUSTOM_MEDIA_CONTRACTS: readonly CustomMediaContract[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    runtimeApiProtocol: 'openai-responses',
    capabilities: ['imageGenerate', 'videoGenerate', 'tts', 'transcribe'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModelByCapability: {
      imageGenerate: 'gpt-image-2',
      videoGenerate: 'sora-2',
      tts: 'gpt-4o-mini-tts',
      transcribe: 'gpt-4o-mini-transcribe',
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    runtimeApiProtocol: 'google-generative-ai',
    capabilities: ['imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModelByCapability: {
      imageGenerate: 'gemini-3.1-flash-image-preview',
      videoGenerate: 'veo-3.1-fast-generate-preview',
      musicGenerate: 'lyria-3-clip-preview',
      tts: 'gemini-3.1-flash-tts-preview',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    runtimeApiProtocol: 'openai-completions',
    capabilities: ['imageGenerate', 'videoGenerate', 'tts', 'transcribe'],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModelByCapability: {
      imageGenerate: 'google/gemini-3.1-flash-image-preview',
      videoGenerate: 'google/veo-3.1-fast',
      tts: 'hexgrad/kokoro-82m',
      transcribe: 'openai/whisper-large-v3-turbo',
    },
  },
] as const;

const CONTRACT_BY_ID = new Map(CUSTOM_MEDIA_CONTRACTS.map((contract) => [contract.id, contract]));

export function getCustomMediaContract(id: string | undefined): CustomMediaContract | undefined {
  return id ? CONTRACT_BY_ID.get(id as CustomMediaApiProtocol) : undefined;
}

export function isCustomMediaCapability(value: unknown): value is CustomMediaCapability {
  return value === 'imageGenerate'
    || value === 'videoGenerate'
    || value === 'musicGenerate'
    || value === 'tts'
    || value === 'transcribe';
}

export function isCustomMediaApiProtocol(value: unknown): value is CustomMediaApiProtocol {
  return typeof value === 'string' && CONTRACT_BY_ID.has(value as CustomMediaApiProtocol);
}
