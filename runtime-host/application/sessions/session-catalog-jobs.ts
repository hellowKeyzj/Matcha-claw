import type { RuntimeJobSnapshot } from '../common/runtime-contracts';
import type {
  RuntimeLongTaskLookupPort,
  RuntimeLongTaskSubmission,
  RuntimeLongTaskSubmissionPort,
} from '../runtime-host/runtime-task-ports';

export const REFRESH_SESSION_CATALOG_JOB = 'sessions.refreshCatalog';

export type SessionCatalogJobSubmission = RuntimeLongTaskSubmission;

export interface SessionCatalogJobPort {
  submitRefreshCatalog(): SessionCatalogJobSubmission;
  getRefreshCatalogJob(): RuntimeJobSnapshot | null;
}

export function createSessionCatalogJobPort(
  tasks: RuntimeLongTaskSubmissionPort,
  lookup: RuntimeLongTaskLookupPort,
): SessionCatalogJobPort {
  return {
    submitRefreshCatalog: () => tasks.submit(REFRESH_SESSION_CATALOG_JOB, null, {
      queue: 'low',
      dedupeKey: REFRESH_SESSION_CATALOG_JOB,
    }),
    getRefreshCatalogJob: () => lookup.latestByType(REFRESH_SESSION_CATALOG_JOB),
  };
}
