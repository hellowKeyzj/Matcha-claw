import { buildSessionIdentityKey, type SessionIdentity } from '../agent-runtime/contracts/runtime-address';
import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';
import type { SessionWindowMode } from './session-window-model';

export const HYDRATE_SESSION_TIMELINE_JOB = 'sessions.hydrateTimeline';

export interface SessionHydrationJobPayload {
  readonly sessionKey: string;
  readonly endpointSessionId?: string;
  readonly sessionIdentity: SessionIdentity;
  readonly snapshot:
    | { readonly kind: 'latest' }
    | { readonly kind: 'state' }
    | {
        readonly kind: 'window';
        readonly mode: SessionWindowMode;
        readonly limit: number;
        readonly offset: number | null;
      };
}

export type SessionHydrationJobSubmission = RuntimeLongTaskSubmission;

export interface SessionHydrationJobPort {
  submitSessionHydration(
    payload: SessionHydrationJobPayload,
  ): SessionHydrationJobSubmission;
}

function buildSessionHydrationDedupeKey(payload: SessionHydrationJobPayload): string {
  const { snapshot } = payload;
  const identityKey = buildSessionIdentityKey(payload.sessionIdentity);
  const endpointSessionKey = payload.endpointSessionId ? `:${payload.endpointSessionId}` : '';
  if (snapshot.kind === 'window') {
    return `${HYDRATE_SESSION_TIMELINE_JOB}:${identityKey}${endpointSessionKey}:window:${snapshot.mode}:${snapshot.limit}:${snapshot.offset ?? ''}`;
  }
  return `${HYDRATE_SESSION_TIMELINE_JOB}:${identityKey}${endpointSessionKey}:${snapshot.kind}`;
}

export function createSessionHydrationJobPort(tasks: RuntimeLongTaskSubmissionPort): SessionHydrationJobPort {
  return {
    submitSessionHydration: (payload) => tasks.submit(HYDRATE_SESSION_TIMELINE_JOB, payload, {
      queue: 'low',
      dedupeKey: buildSessionHydrationDedupeKey(payload),
      resultRetention: 'drop',
    }),
  };
}
