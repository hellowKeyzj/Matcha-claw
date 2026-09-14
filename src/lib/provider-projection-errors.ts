import i18n from '@/i18n';
import type { ProviderMutationReceipt } from '@/lib/host-api-transport-contract';

const PRIVATE_RESOLVER_PREFIX = 'private-resolver-';

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

export function nativeProjectionError(receipt: ProviderMutationReceipt): string | undefined {
  const diagnostic = receipt.native.diagnostic;
  if (diagnostic) {
    const privateResolverError = privateResolverProjectionError(diagnostic.detail);
    if (privateResolverError) return privateResolverError;
    const projectionError = projectionReasonError(diagnostic.reason);
    if (projectionError) return projectionError;
    return i18n.t('settings:aiProviders.projectionErrors.diagnostic', {
      reason: diagnostic.reason,
    });
  }
  if (receipt.native.observed.status === 'mismatch') {
    return i18n.t('settings:aiProviders.projectionErrors.readbackMismatch');
  }
  if (receipt.native.observed.status === 'unavailable') {
    return i18n.t('settings:aiProviders.projectionErrors.readbackUnavailable');
  }
  if (receipt.native.applied.status === 'unknown') {
    return i18n.t('settings:aiProviders.projectionErrors.outcomeUnknown');
  }
  return undefined;
}

function privateResolverProjectionError(detail: string | undefined): string | undefined {
  if (!detail?.startsWith(PRIVATE_RESOLVER_PREFIX)) return undefined;
  const code = detail.slice(PRIVATE_RESOLVER_PREFIX.length).split(' ')[0];
  const key = PRIVATE_RESOLVER_ERROR_KEYS[code] ?? 'unknown';
  return i18n.t(`settings:aiProviders.projectionErrors.privateResolver.${key}`);
}

function projectionReasonError(reason: string): string | undefined {
  const key = PROJECTION_ERROR_REASON_KEYS[reason];
  if (!key) return undefined;
  return i18n.t(`settings:aiProviders.projectionErrors.${key}`);
}
