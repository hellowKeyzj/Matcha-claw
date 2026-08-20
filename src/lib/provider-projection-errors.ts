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

export function nativeProjectionError(receipt: ProviderMutationReceipt): string | undefined {
  const diagnostic = receipt.native.diagnostic;
  if (diagnostic) {
    const mapped = privateResolverProjectionError(diagnostic.detail);
    if (mapped) return mapped;
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
