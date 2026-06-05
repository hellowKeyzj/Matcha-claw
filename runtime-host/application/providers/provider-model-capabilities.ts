import type { CustomMediaApiProtocol, ModelCapability, ProviderCredential, ProviderType } from './provider-types';
import { getCustomMediaContract } from './custom-media-provider-contracts';

export type ProviderCapabilityCredential = Pick<ProviderCredential, 'vendorId' | 'apiProtocol' | 'providerKind' | 'mediaApiProtocol'>;

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
  'transcribe',
];

type CapabilityRule = {
  readonly fixed?: readonly ModelCapability[];
  readonly byProtocol?: Partial<Record<NonNullable<ProviderCredential['apiProtocol']>, readonly ModelCapability[]>>;
};

const CHAT_ONLY = ['chat'] as const satisfies readonly ModelCapability[];
const CHAT_WITH_IMAGE_UNDERSTANDING = ['chat', 'imageUnderstand'] as const satisfies readonly ModelCapability[];

const PROVIDER_CAPABILITY_RULES: Partial<Record<ProviderType, CapabilityRule>> = {
  anthropic: { fixed: CHAT_WITH_IMAGE_UNDERSTANDING },
  openai: { fixed: ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'tts', 'transcribe'] },
  google: { fixed: ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'] },
  openrouter: { fixed: ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'tts', 'transcribe'] },
  ark: { fixed: CHAT_WITH_IMAGE_UNDERSTANDING },
  moonshot: { fixed: CHAT_WITH_IMAGE_UNDERSTANDING },
  'moonshot-global': { fixed: CHAT_WITH_IMAGE_UNDERSTANDING },
  siliconflow: { fixed: CHAT_ONLY },
  deepseek: { fixed: CHAT_ONLY },
  'minimax-portal': { fixed: ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'] },
  'minimax-portal-cn': { fixed: ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'] },
  'qwen-portal': { fixed: ['chat', 'imageUnderstand', 'videoGenerate'] },
  ollama: {
    fixed: CHAT_WITH_IMAGE_UNDERSTANDING,
    byProtocol: {
      'openai-completions': CHAT_ONLY,
      'openai-responses': CHAT_ONLY,
      'anthropic-messages': CHAT_ONLY,
      openrouter: CHAT_ONLY,
    },
  },
  custom: {
    fixed: CHAT_WITH_IMAGE_UNDERSTANDING,
    byProtocol: {
      'openai-completions': CHAT_WITH_IMAGE_UNDERSTANDING,
      'openai-responses': CHAT_WITH_IMAGE_UNDERSTANDING,
      'anthropic-messages': CHAT_WITH_IMAGE_UNDERSTANDING,
      openrouter: CHAT_WITH_IMAGE_UNDERSTANDING,
    },
  },
};

function uniqueCapabilities(capabilities: readonly ModelCapability[]): ModelCapability[] {
  const out: ModelCapability[] = [];
  const seen = new Set<ModelCapability>();
  for (const capability of capabilities) {
    if (seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
  }
  return out;
}

export function resolveProviderModelCapabilities(
  credential: ProviderCapabilityCredential,
): ModelCapability[] {
  if (credential.vendorId === 'custom' && credential.providerKind === 'media') {
    const contract = getCustomMediaContract(credential.mediaApiProtocol as CustomMediaApiProtocol | undefined);
    return contract ? [...contract.capabilities] : [];
  }
  const rule = PROVIDER_CAPABILITY_RULES[credential.vendorId];
  const protocolCapabilities = credential.apiProtocol ? rule?.byProtocol?.[credential.apiProtocol] : undefined;
  return uniqueCapabilities(protocolCapabilities ?? rule?.fixed ?? CHAT_ONLY);
}

export function filterAllowedModelCapabilities(
  credential: ProviderCapabilityCredential,
  capabilities: readonly ModelCapability[],
): ModelCapability[] {
  const allowed = new Set(resolveProviderModelCapabilities(credential));
  return uniqueCapabilities(capabilities.filter((capability) => allowed.has(capability)));
}

export function findDisallowedModelCapabilities(
  credential: ProviderCapabilityCredential,
  capabilities: readonly ModelCapability[],
): ModelCapability[] {
  const allowed = new Set(resolveProviderModelCapabilities(credential));
  return uniqueCapabilities(capabilities.filter((capability) => !allowed.has(capability)));
}

export function modelCapabilitiesToRuntimeInput(capabilities: readonly ModelCapability[]): string[] {
  return capabilities.includes('imageUnderstand') ? ['text', 'image'] : ['text'];
}
