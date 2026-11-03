import type {
  CustomMediaCapability,
  CustomMediaApiProtocol,
} from '@/plugins/providers/domain/providers';

export type CustomMediaContract = {
  readonly id: CustomMediaApiProtocol;
  readonly label: string;
  readonly runtimeApiProtocol: 'openai-responses' | 'google-generative-ai' | 'openai-completions';
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
      videoGenerate: 'gemini-omni-1.1-flash',
      musicGenerate: 'lyria-3.5',
      tts: 'gemini-3.8-flash-tts',
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
    },
  },
  {
    id: 'dashscope',
    label: 'Alibaba Cloud DashScope',
    runtimeApiProtocol: 'openai-completions',
    capabilities: ['imageGenerate', 'videoGenerate', 'tts'],
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    defaultModelByCapability: {},
  },
  {
    id: 'ark',
    label: 'ByteDance Ark',
    runtimeApiProtocol: 'openai-completions',
    capabilities: ['imageGenerate', 'videoGenerate'],
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModelByCapability: {},
  },
] as const;

const CONTRACT_BY_ID = new Map(CUSTOM_MEDIA_CONTRACTS.map((contract) => [contract.id, contract]));

export function getCustomMediaContract(id: string | undefined): CustomMediaContract | undefined {
  return id ? CONTRACT_BY_ID.get(id as CustomMediaApiProtocol) : undefined;
}
