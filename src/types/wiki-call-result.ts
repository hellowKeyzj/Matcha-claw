import type { WikiInsightResearchInputReceipt, WikiLintFixReceipt, WikiQuestionSaveReceipt, WikiRebuildIndexReceipt } from './wiki-capabilities';

export interface WikiProjectImportResult {
  projects: { projectId: string; title: string; rootPath: string; isCurrent: boolean; createdAtMs: number; openedAtMs: number }[];
  currentProjectId: string | null;
}

export interface WikiWriteResult {
  relativePath: string;
  revision: { id: string; size: number; modifiedAtMs: number };
}

export interface WikiDeleteSourceResult {
  sourceRelativePath: string;
  deletedPages: string[];
  updatedPages: string[];
  deletedMedia: string[];
}

export type WikiCallResult =
  | { callId: string; operation: 'apply-generated-pages'; result: { writtenPages: WikiWriteResult[] } }
  | { callId: string; operation: 'delete-source'; result: WikiDeleteSourceResult }
  | { callId: string; operation: 'project.import-archive'; result: WikiProjectImportResult }
  | { callId: string; operation: 'rebuild-index'; result: WikiRebuildIndexReceipt }
  | { callId: string; operation: 'qa.save'; result: WikiQuestionSaveReceipt }
  | { callId: string; operation: 'lint.fix' | 'lint.review' | 'lint.delete'; result: WikiLintFixReceipt }
  | { callId: string; operation: 'graph.insights.research-input'; result: WikiInsightResearchInputReceipt };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !/^[a-z]:/i.test(value) && !value.startsWith('/') && !value.includes('\0')
    && value.split('/').every((part) => part !== '..');
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(relativePath);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function writeResult(value: unknown): value is WikiWriteResult {
  if (!record(value) || !exact(value, ['relativePath', 'revision']) || !relativePath(value.relativePath)
    || !record(value.revision) || !exact(value.revision, ['id', 'size', 'modifiedAtMs'])) return false;
  return typeof value.revision.id === 'string' && /^[a-f0-9]{16}$/.test(value.revision.id)
    && integer(value.revision.size) && integer(value.revision.modifiedAtMs);
}

export function decodeWikiCallResult(value: unknown): WikiCallResult {
  if (record(value) && exact(value, ['callId', 'operation', 'result']) && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId)
    && record(value.result)) {
    if (value.operation === 'qa.save' && exact(value.result, ['projectId', 'savedPath'])
      && typeof value.result.projectId === 'string' && relativePath(value.result.savedPath)) {
      return { callId: value.callId, operation: value.operation, result: {
        projectId: value.result.projectId, savedPath: value.result.savedPath,
      } };
    }
    if (value.operation === 'rebuild-index' && exact(value.result, ['projectId', 'pages', 'groups'])
      && typeof value.result.projectId === 'string' && integer(value.result.pages) && integer(value.result.groups)) {
      return { callId: value.callId, operation: value.operation, result: {
        projectId: value.result.projectId, pages: value.result.pages, groups: value.result.groups,
      } };
    }
    if (value.operation === 'graph.insights.research-input'
      && exact(value.result, ['projectId', 'insightKey', 'topic', 'searchQueries'])
      && typeof value.result.projectId === 'string' && typeof value.result.insightKey === 'string'
      && typeof value.result.topic === 'string' && strings(value.result.searchQueries)) {
      return { callId: value.callId, operation: value.operation, result: {
        projectId: value.result.projectId, insightKey: value.result.insightKey,
        topic: value.result.topic, searchQueries: value.result.searchQueries,
      } };
    }
    if ((value.operation === 'lint.fix' || value.operation === 'lint.review' || value.operation === 'lint.delete')
      && exact(value.result, ['projectId', 'fixedIds', 'reviewedIds', 'writtenPages', 'deletedPages', 'failures'])
      && typeof value.result.projectId === 'string' && strings(value.result.fixedIds)
      && strings(value.result.reviewedIds) && paths(value.result.writtenPages) && paths(value.result.deletedPages)
      && Array.isArray(value.result.failures) && value.result.failures.every((failure) => record(failure)
        && exact(failure, ['id', 'message']) && typeof failure.id === 'string' && typeof failure.message === 'string')) {
      return { callId: value.callId, operation: value.operation, result: value.result as unknown as WikiLintFixReceipt };
    }
    if (value.operation === 'project.import-archive' && exact(value.result, ['projects', 'currentProjectId'])
      && (value.result.currentProjectId === null || typeof value.result.currentProjectId === 'string')
      && Array.isArray(value.result.projects) && value.result.projects.every((project) => record(project)
        && exact(project, ['projectId', 'title', 'rootPath', 'isCurrent', 'createdAtMs', 'openedAtMs'])
        && typeof project.projectId === 'string' && typeof project.title === 'string'
        && typeof project.rootPath === 'string' && typeof project.isCurrent === 'boolean'
        && integer(project.createdAtMs) && integer(project.openedAtMs))) {
      return { callId: value.callId, operation: value.operation, result: value.result as unknown as WikiProjectImportResult };
    }
    if (value.operation === 'apply-generated-pages' && exact(value.result, ['writtenPages'])
      && Array.isArray(value.result.writtenPages) && value.result.writtenPages.every(writeResult)) {
      return { callId: value.callId, operation: value.operation, result: { writtenPages: value.result.writtenPages } };
    }
    if (value.operation === 'delete-source'
      && exact(value.result, ['sourceRelativePath', 'deletedPages', 'updatedPages', 'deletedMedia'])
      && relativePath(value.result.sourceRelativePath) && paths(value.result.deletedPages)
      && paths(value.result.updatedPages) && paths(value.result.deletedMedia)) {
      return { callId: value.callId, operation: value.operation, result: {
        sourceRelativePath: value.result.sourceRelativePath,
        deletedPages: value.result.deletedPages, updatedPages: value.result.updatedPages, deletedMedia: value.result.deletedMedia,
      } };
    }
  }
  throw new Error('Invalid Wiki call result');
}
