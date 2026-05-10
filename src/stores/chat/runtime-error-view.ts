import type {
  ChatRuntimeErrorDismissMarker,
  ChatSessionRuntimeState,
} from './types';

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

export function buildRuntimeErrorFingerprint(
  runtime: Pick<ChatSessionRuntimeState, 'lastError' | 'lastIssue'>,
): string | null {
  const lastError = normalizeText(runtime.lastError);
  const issue = runtime.lastIssue;
  if (!lastError && !issue) {
    return null;
  }
  if (!issue) {
    return `error:${lastError}`;
  }
  return [
    `error:${lastError ?? ''}`,
    `issue-source:${normalizeText(issue.source) ?? ''}`,
    `issue-code:${normalizeText(issue.code) ?? ''}`,
    `issue-message:${normalizeText(issue.message) ?? ''}`,
    `issue-details:${stableStringify(issue.details ?? null)}`,
  ].join('|');
}

export function buildRuntimeErrorDismissMarker(
  runtime: Pick<ChatSessionRuntimeState, 'lastError' | 'lastIssue' | 'updatedAt'>,
): ChatRuntimeErrorDismissMarker | null {
  const fingerprint = buildRuntimeErrorFingerprint(runtime);
  if (!fingerprint) {
    return null;
  }
  return {
    updatedAt: typeof runtime.updatedAt === 'number' ? runtime.updatedAt : null,
    fingerprint,
  };
}

export function hasVisibleRuntimeError(input: {
  runtime: Pick<ChatSessionRuntimeState, 'lastError' | 'lastIssue' | 'updatedAt'>;
  dismissedMarker: ChatRuntimeErrorDismissMarker | undefined;
}): boolean {
  const marker = buildRuntimeErrorDismissMarker(input.runtime);
  if (!marker) {
    return false;
  }
  return !(
    input.dismissedMarker?.updatedAt === marker.updatedAt
    && input.dismissedMarker.fingerprint === marker.fingerprint
  );
}
