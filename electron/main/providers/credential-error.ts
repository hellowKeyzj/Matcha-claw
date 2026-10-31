export type PrivateResolverFailureCode =
  | 'invalid-request'
  | 'credential-missing'
  | 'credential-decrypt-failed'
  | 'credential-provider-mismatch'
  | 'credential-invalid'
  | 'auth-profile-read-invalid'
  | 'auth-profile-write-failed'
  | 'credential-store-unavailable'
  | 'unknown';

export class ProviderPrivateResolverError extends Error {
  constructor(readonly code: PrivateResolverFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ProviderPrivateResolverError';
  }
}
