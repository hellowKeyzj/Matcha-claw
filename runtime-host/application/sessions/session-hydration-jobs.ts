import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';
import type { SessionWindowMode } from './session-window-model';

export const HYDRATE_SESSION_TIMELINE_JOB = 'sessions.hydrateTimeline';

export interface SessionHydrationJobPayload {
  readonly sessionKey: string;
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

export function createSessionHydrationJobPort(tasks: RuntimeLongTaskSubmissionPort): SessionHydrationJobPort {
  return {
    submitSessionHydration: (payload) => tasks.submit(HYDRATE_SESSION_TIMELINE_JOB, payload, {
      queue: 'low',
      dedupeKey: `${HYDRATE_SESSION_TIMELINE_JOB}:${payload.sessionKey}:${payload.snapshot.kind}`,
    }),
  };
}
