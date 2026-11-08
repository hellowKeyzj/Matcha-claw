import { AppError } from '@/lib/error-model';

export type WikiObservationFailure = Readonly<{
  reason: 'retry' | 'stopped';
  message: string;
}>;

export function classifyWikiObservationFailure(error: unknown, retryMessage: string): WikiObservationFailure {
  const status = error instanceof AppError ? error.details?.status : undefined;
  const retryable = typeof status === 'number'
    ? status === 408 || status === 429 || status >= 500 && status <= 599
    : error instanceof AppError && ['TIMEOUT', 'NETWORK', 'UNAVAILABLE'].includes(error.code);
  return {
    reason: retryable ? 'retry' : 'stopped',
    message: !retryable && error instanceof Error ? error.message : retryMessage,
  };
}
