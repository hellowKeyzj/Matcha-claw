import { AppError, normalizeAppError } from './error-model';
import { isSkillsCallReason } from '@/types/call-log/skills';

export function sealedSkillMutationError(result: { outcome: string; reason?: string }): AppError {
  return new AppError(result.outcome === 'unknown' ? 'UNAVAILABLE' : 'CONFIG', 'Skill package operation did not complete', undefined, {
    outcome: result.outcome,
    ...(isSkillsCallReason(result.reason) ? { reason: result.reason } : {}),
  });
}

export function sealedSkillErrorMessage(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
  fallback: string,
): string {
  const failure = error instanceof AppError ? error : normalizeAppError(error,
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? { status: error.status } : undefined);
  if (failure.details?.outcome === 'unknown') return t('sealed.errors.outcomeUnknown');
  if (isSkillsCallReason(failure.details?.reason) && failure.details.reason !== 'cleanup-failed') return t(`sealed.errors.${failure.details.reason}`);
  if (failure.details?.outcome === 'notFound') return t('sealed.errors.not-found');
  if (failure.details?.outcome === 'rejected') return t('sealed.errors.rejected');
  const status = failure.details?.status;
  if (status === 401) return t('sealed.errors.signInRequired');
  if (status === 403) return t('sealed.errors.permissionDenied');
  const code = ['MATCHA_PACKAGE_CLOUD_ENVELOPE_REQUIRED', 'MATCHA_PACKAGE_VERSION_NOT_PUBLISHABLE'].find((value) => failure.message.includes(value));
  if (code) return t(`sealed.errors.${code}`);
  if (typeof status === 'number') return t('sealed.errors.requestFailed', { status });
  if (failure.code === 'AUTH_INVALID') return t('sealed.errors.signInRequired');
  if (failure.code === 'PERMISSION') return t('sealed.errors.permissionDenied');
  if (failure.code === 'NETWORK' || failure.code === 'TIMEOUT' || failure.code === 'UNAVAILABLE' || error === 'cloudUnavailable') return t('sealed.cloudUnavailableDescription');
  if (failure.code === 'INVALID_RESPONSE') return t('sealed.errors.invalidResponse');
  return t(fallback);
}
