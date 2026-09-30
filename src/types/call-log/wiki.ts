export interface WikiSourceCallCounts {
  imported: number;
  skipped: number;
  deleted: number;
  moved: number;
}

export type WikiSourceCallOperation = 'import-source' | 'import-folder' | 'refresh-sources';
export type WikiFeatureCallOperation = 'history.restore' | 'history.clear'
  | 'project.export-archive' | 'project.import-archive' | 'rebuild-index'
  | 'qa.ask' | 'qa.save' | 'lint.run' | 'lint.fix' | 'lint.review' | 'lint.delete'
  | 'embedding.reindex' | 'graph.insights.research-input';

const featureOperations: readonly WikiFeatureCallOperation[] = [
  'history.restore', 'history.clear', 'project.export-archive', 'project.import-archive',
  'rebuild-index', 'qa.ask', 'qa.save', 'lint.run', 'lint.fix', 'lint.review', 'lint.delete',
  'embedding.reindex', 'graph.insights.research-input',
];

type WikiCallOutcome = 'completed' | 'cancelled' | 'rejected' | 'unavailable' | 'failed' | null;
type WikiSourceTaskState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused' | 'missing' | null;

export type WikiCallDetail =
  | { operation?: never; outcome: WikiCallOutcome }
  | { operation: 'source-task.retry' | 'source-task.resume'; outcome: WikiCallOutcome | 'incomplete'; taskState: WikiSourceTaskState }
  | { operation: 'embed-page' | 'rescan-sources' | WikiFeatureCallOperation; outcome: WikiCallOutcome }
  | { operation: 'research.start' | 'research-task.rerun'; outcome: WikiCallOutcome; counts: { done: number; error: number; saved: number } | null }
  | { operation: 'apply-generated-pages'; outcome: WikiCallOutcome; counts: { writtenPages: number } | null }
  | { operation: 'delete-source'; outcome: WikiCallOutcome; counts: { deletedPages: number; updatedPages: number; deletedMedia: number } | null }
  | { operation: WikiSourceCallOperation; outcome: WikiCallOutcome; counts: WikiSourceCallCounts | null };

declare module '../call-log' {
  interface CallDetailByModule {
    wiki: WikiCallDetail;
  }
}

export function decodeWikiCallDetail(value: unknown): WikiCallDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'outcome')) return null;
  const { operation, outcome, counts, taskState } = value as Record<string, unknown>;
  if (operation === 'source-task.retry' || operation === 'source-task.resume') {
    if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'taskState')
      || (taskState !== null && !['pending', 'running', 'done', 'failed', 'cancelled', 'paused', 'missing'].includes(taskState as string))
      || (outcome !== null && !['completed', 'cancelled', 'rejected', 'unavailable', 'failed', 'incomplete'].includes(outcome as string))) return null;
    return { operation, outcome: outcome as WikiCallOutcome | 'incomplete', taskState: taskState as WikiSourceTaskState };
  }
  if (outcome !== null && outcome !== 'completed' && outcome !== 'cancelled'
    && outcome !== 'rejected' && outcome !== 'unavailable' && outcome !== 'failed') return null;
  if (!Object.hasOwn(value, 'operation')) {
    return Object.keys(value).length === 1 ? { outcome } : null;
  }
  if (typeof operation === 'string' && featureOperations.includes(operation as WikiFeatureCallOperation)) {
    return Object.keys(value).length === 2 ? { operation: operation as WikiFeatureCallOperation, outcome } : null;
  }
  if (operation === 'embed-page' || operation === 'rescan-sources') {
    return Object.keys(value).length === 2 ? { operation, outcome } : null;
  }
  if (operation === 'research.start' || operation === 'research-task.rerun') {
    if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'counts')) return null;
    if (counts === null) return { operation, outcome, counts };
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.keys(counts).length !== 3
      || !['done', 'error', 'saved'].every((key) => Object.hasOwn(counts, key)
        && Number.isSafeInteger((counts as Record<string, unknown>)[key])
        && ((counts as Record<string, unknown>)[key] as number) >= 0)) return null;
    return { operation, outcome, counts: counts as { done: number; error: number; saved: number } };
  }
  if (operation === 'apply-generated-pages' || operation === 'delete-source') {
    if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'counts')) return null;
    if (outcome !== 'completed') return counts === null ? { operation, outcome, counts } : null;
    const keys = operation === 'apply-generated-pages' ? ['writtenPages'] : ['deletedPages', 'updatedPages', 'deletedMedia'];
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.keys(counts).length !== keys.length
      || !keys.every((key) => Object.hasOwn(counts, key)
        && Number.isSafeInteger((counts as Record<string, unknown>)[key])
        && ((counts as Record<string, unknown>)[key] as number) >= 0)) return null;
    return operation === 'apply-generated-pages'
      ? { operation, outcome, counts: counts as { writtenPages: number } }
      : { operation, outcome, counts: counts as { deletedPages: number; updatedPages: number; deletedMedia: number } };
  }
  if ((operation !== 'import-source' && operation !== 'import-folder' && operation !== 'refresh-sources')
    || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'counts')) return null;
  if (outcome !== 'completed') return counts === null ? { operation, outcome, counts } : null;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)
    || Object.keys(counts).length !== 4
    || !['imported', 'skipped', 'deleted', 'moved'].every((key) => Object.hasOwn(counts, key)
      && Number.isSafeInteger((counts as Record<string, unknown>)[key])
      && ((counts as Record<string, unknown>)[key] as number) >= 0)) return null;
  const decoded = counts as WikiSourceCallCounts;
  if (operation === 'import-source'
    && (decoded.imported !== 1 || decoded.skipped !== 0 || decoded.deleted !== 0 || decoded.moved !== 0)) return null;
  if (operation === 'import-folder' && (decoded.deleted !== 0 || decoded.moved !== 0)) return null;
  return { operation, outcome, counts: decoded };
}
