import i18n from '@/i18n';
import type { ProviderDiagnostic } from '@/types/provider-runtime-report';

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
  'provider-projection-partial': 'providerProjectionPartial',
  'provider-auth-unsupported': 'providerAuthUnsupported',
  'provider-restart-required': 'providerRestartRequired',
  'provider-cleanup-partial': 'providerCleanupPartial',
  'provider-projection-not-sent': 'providerProjectionNotSent',
  'provider-projection-outcome-unknown': 'providerProjectionOutcomeUnknown',
  'provider-cleanup-blocked': 'providerCleanupBlocked',
  'provider-projection-rejected': 'providerProjectionRejected',
  'private-resolver-unavailable': 'privateResolverUnavailable',
  'config-readback-mismatch': 'readbackMismatch',
  'config-readback-unavailable': 'readbackUnavailable',
};

export class ProviderMutationError extends Error {
  constructor(readonly reason: 'rejected' | 'unknown') {
    super(i18n.t(`settings:aiProviders.dialog.saveErrors.${reason}`));
    this.name = 'ProviderMutationError';
  }
}

export function providerDiagnosticError(diagnostic: ProviderDiagnostic | null): string | undefined {
  if (diagnostic?.privateResolverCode) {
    const key = PRIVATE_RESOLVER_ERROR_KEYS[diagnostic.privateResolverCode];
    return i18n.t(`settings:aiProviders.projectionErrors.privateResolver.${key}`);
  }
  if (diagnostic?.reason === 'private-profile-credential-missing') {
    return i18n.t('settings:aiProviders.projectionErrors.privateResolver.credentialMissing');
  }
  if (diagnostic?.reason) {
    const key = PROJECTION_ERROR_REASON_KEYS[diagnostic.reason];
    return i18n.t(`settings:aiProviders.projectionErrors.${key ?? 'outcomeUnknown'}`);
  }
  return undefined;
}
