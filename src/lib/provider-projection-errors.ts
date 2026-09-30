import i18n from '@/i18n';
import type { ProviderCallDetail } from '@/types/call-log/provider';

const PRIVATE_RESOLVER_ERROR_KEYS: Record<string, string> = {
  'credential-missing': 'credentialMissing',
  'credential-decrypt-failed': 'credentialDecryptFailed',
  'credential-provider-mismatch': 'credentialProviderMismatch',
  'credential-invalid': 'credentialInvalid',
  'auth-profile-read-invalid': 'authProfileReadInvalid',
  'auth-profile-write-failed': 'authProfileWriteFailed',
  'credential-store-unavailable': 'credentialStoreUnavailable',
  'invalid-request': 'invalidRequest',
  'unknown': 'unknown',
};

const PROJECTION_ERROR_REASON_KEYS: Record<string, string> = {
  'provider-account-configuration-invalid': 'providerAccountConfigurationInvalid',
  'provider-cascade-unavailable': 'providerCascadeUnavailable',
  'provider-credential-unavailable': 'providerCredentialUnavailable',
  'provider-key-duplicate': 'providerKeyDuplicate',
  'provider-model-capability-invalid': 'providerModelCapabilityInvalid',
  'provider-model-identifier-invalid': 'providerModelIdentifierInvalid',
  'provider-model-persistence-failed': 'providerModelPersistenceFailed',
  'provider-model-token-limit-invalid': 'providerModelTokenLimitInvalid',
  'provider-owner-response-unavailable': 'providerOwnerResponseUnavailable',
  'provider-owner-unavailable': 'providerOwnerUnavailable',
  'provider-routing-account-unavailable': 'providerRoutingAccountUnavailable',
  'provider-routing-credential-unavailable': 'providerRoutingCredentialUnavailable',
  'provider-routing-invalid': 'providerRoutingInvalid',
  'provider-routing-model-capability-unavailable': 'providerRoutingModelCapabilityUnavailable',
  'provider-routing-model-unavailable': 'providerRoutingModelUnavailable',
  'provider-routing-persistence-failed': 'providerRoutingPersistenceFailed',
};

export function nativeProjectionError(receipt: ProviderCallDetail): string | undefined {
  const diagnostic = receipt.diagnostic;
  if (diagnostic?.privateResolverCode) {
    const key = PRIVATE_RESOLVER_ERROR_KEYS[diagnostic.privateResolverCode];
    return i18n.t(`settings:aiProviders.projectionErrors.privateResolver.${key}`);
  }
  if (diagnostic?.reason) {
    const key = PROJECTION_ERROR_REASON_KEYS[diagnostic.reason];
    if (key) return i18n.t(`settings:aiProviders.projectionErrors.${key}`);
  }
  if (receipt.native?.observed === 'mismatch') {
    return i18n.t('settings:aiProviders.projectionErrors.readbackMismatch');
  }
  if (receipt.native?.applied === 'unknown') {
    return i18n.t('settings:aiProviders.projectionErrors.outcomeUnknown');
  }
  if (receipt.native?.observed === 'unavailable') {
    return i18n.t('settings:aiProviders.projectionErrors.readbackUnavailable');
  }
  if (diagnostic) return i18n.t('settings:aiProviders.projectionErrors.outcomeUnknown');
  return undefined;
}
