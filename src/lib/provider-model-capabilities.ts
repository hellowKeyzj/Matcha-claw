import type { ModelCapability, ProviderCredential, ProviderVendorInfo } from '@/lib/providers';
import { getCustomMediaContract } from '@/lib/custom-media-provider-contracts';

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
  'transcribe',
];

const CHAT_ONLY = ['chat'] as const satisfies readonly ModelCapability[];
const CHAT_WITH_IMAGE_UNDERSTANDING = ['chat', 'imageUnderstand'] as const satisfies readonly ModelCapability[];

export function resolveProviderModelCapabilities(
  credential: Pick<ProviderCredential, 'vendorId' | 'apiProtocol' | 'providerKind' | 'mediaApiProtocol'>,
  vendor?: Pick<ProviderVendorInfo, 'modelCapabilities'>,
): ModelCapability[] {
  if (credential.vendorId === 'custom' && credential.providerKind === 'media') {
    const contract = getCustomMediaContract(credential.mediaApiProtocol);
    return contract ? [...contract.capabilities] : [];
  }
  if (credential.vendorId === 'custom') {
    return [...CHAT_WITH_IMAGE_UNDERSTANDING];
  }
  if (credential.vendorId === 'ollama' && credential.apiProtocol) {
    return [...CHAT_ONLY];
  }
  return vendor?.modelCapabilities?.length ? [...vendor.modelCapabilities] : [...CHAT_ONLY];
}

export function filterAllowedModelCapabilities(
  credential: Pick<ProviderCredential, 'vendorId' | 'apiProtocol' | 'providerKind' | 'mediaApiProtocol'>,
  capabilities: readonly ModelCapability[],
  vendor?: Pick<ProviderVendorInfo, 'modelCapabilities'>,
): ModelCapability[] {
  const allowed = new Set(resolveProviderModelCapabilities(credential, vendor));
  const out: ModelCapability[] = [];
  for (const capability of capabilities) {
    if (!allowed.has(capability) || out.includes(capability)) continue;
    out.push(capability);
  }
  return out;
}
