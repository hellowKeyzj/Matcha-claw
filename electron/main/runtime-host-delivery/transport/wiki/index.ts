import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import { decodeWikiCallResult, type WikiCallResult } from '../../../../../src/types/wiki-call-result';
import { decodeWikiSelectionTask } from '../../../../../src/types/wiki-selection';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const WIKI_CAPABILITY = 'wiki';
const WIKI_SUBJECT = 'wiki';
const WIKI_UNAVAILABLE = { success: false, error: 'Wiki is unavailable' } as const;

export type WikiTransportResponse = Readonly<{
  status: 200 | 400 | 404 | 409 | 422 | 503;
  body: unknown;
}>;

type WikiCallTransportResponse = Readonly<
  { status: 202; body: CallReceipt } | { status: 400 | 404 | 409 | 422 | 503; body: unknown }
>;

export interface WikiTransport {
  status(): Promise<WikiTransportResponse>;
  projects(): Promise<WikiTransportResponse>;
  projectTemplates(): Promise<WikiTransportResponse>;
  createProject(request: unknown): Promise<WikiTransportResponse>;
  openProject(request: unknown): Promise<WikiTransportResponse>;
  currentProject(): Promise<WikiTransportResponse>;
  files(projectId?: string, directory?: string): Promise<WikiTransportResponse>;
  navigation(projectId?: string): Promise<WikiTransportResponse>;
  deletePage(request: unknown): Promise<WikiCallTransportResponse>;
  readFile(request: unknown): Promise<WikiTransportResponse>;
  readBinaryFile(request: unknown): Promise<WikiTransportResponse>;
  readSourcePreview(request: unknown): Promise<WikiTransportResponse>;
  writeFile(request: unknown): Promise<WikiTransportResponse>;
  search(request: unknown): Promise<WikiTransportResponse>;
  searchConfig(projectId?: string): Promise<WikiTransportResponse>;
  updateSearchConfig(request: unknown): Promise<WikiTransportResponse>;
  graph(projectId?: string): Promise<WikiTransportResponse>;
  sourceWatchConfig(projectId?: string): Promise<WikiTransportResponse>;
  updateSourceWatchConfig(request: unknown): Promise<WikiTransportResponse>;
  rescanSources(request: unknown): Promise<WikiCallTransportResponse>;
  importSource(request: unknown): Promise<WikiCallTransportResponse>;
  importFolder(request: unknown): Promise<WikiCallTransportResponse>;
  refreshSources(request: unknown): Promise<WikiCallTransportResponse>;
  applyGeneratedPages(request: unknown): Promise<WikiCallTransportResponse>;
  deleteSource(request: unknown): Promise<WikiCallTransportResponse>;
  callResult(request: unknown): Promise<{ status: 200; body: WikiCallResult } | { status: 400 | 404 | 409 | 422 | 503; body: unknown }>;
  reviews(projectId?: string): Promise<WikiTransportResponse>;
  resolveReview(request: unknown): Promise<WikiTransportResponse>;
  dismissReview(request: unknown): Promise<WikiTransportResponse>;
  clearResolvedReviews(request: unknown): Promise<WikiTransportResponse>;
  sourceFiles(projectId?: string): Promise<WikiTransportResponse>;
  sourceTasks(request: unknown): Promise<WikiTransportResponse>;
  cancelSourceTask(request: unknown): Promise<WikiTransportResponse>;
  embedPage(request: unknown): Promise<WikiCallTransportResponse>;
  retrieveContext(request: unknown): Promise<WikiTransportResponse>;
  historyList(request: unknown): Promise<WikiTransportResponse>;
  historyRestore(request: unknown): Promise<WikiCallTransportResponse>;
  historyStats(projectId?: string): Promise<WikiTransportResponse>;
  historyConfig(projectId?: string): Promise<WikiTransportResponse>;
  updateHistoryConfig(request: unknown): Promise<WikiTransportResponse>;
  historyClear(request: unknown): Promise<WikiCallTransportResponse>;
  exportArchive(request: unknown): Promise<WikiCallTransportResponse>;
  importArchive(request: unknown): Promise<WikiCallTransportResponse>;
  rebuildIndex(request: unknown): Promise<WikiCallTransportResponse>;
  detectDuplicates(request: unknown): Promise<WikiCallTransportResponse>;
  mergeDuplicates(request: unknown): Promise<WikiCallTransportResponse>;
  dedupState(projectId?: string): Promise<WikiTransportResponse>;
  cancelDedup(request: unknown): Promise<WikiTransportResponse>;
  retryDedup(request: unknown): Promise<WikiCallTransportResponse>;
  resumeDedup(request: unknown): Promise<WikiCallTransportResponse>;
  excludeDuplicates(request: unknown): Promise<WikiTransportResponse>;
  pageLinks(projectId?: string, relativePath?: string): Promise<WikiTransportResponse>;
  createMissingPage(request: unknown): Promise<WikiCallTransportResponse>;
  cancelMissingPage(request: unknown): Promise<WikiTransportResponse>;
  generateSelection(request: unknown): Promise<WikiCallTransportResponse>;
  selectionTask(projectId?: string, taskId?: string): Promise<WikiTransportResponse>;
  cancelSelection(request: unknown): Promise<WikiTransportResponse>;
  applySelection(request: unknown): Promise<WikiCallTransportResponse>;
  askQuestion(request: unknown): Promise<WikiCallTransportResponse>;
  questionTask(projectId?: string, taskId?: string): Promise<WikiTransportResponse>;
  cancelQuestion(request: unknown): Promise<WikiTransportResponse>;
  saveQuestion(request: unknown): Promise<WikiCallTransportResponse>;
  lintConfig(projectId?: string): Promise<WikiTransportResponse>;
  updateLintConfig(request: unknown): Promise<WikiTransportResponse>;
  lintState(projectId?: string): Promise<WikiTransportResponse>;
  runLint(request: unknown): Promise<WikiCallTransportResponse>;
  cancelLint(request: unknown): Promise<WikiTransportResponse>;
  fixLint(request: unknown): Promise<WikiCallTransportResponse>;
  reviewLint(request: unknown): Promise<WikiCallTransportResponse>;
  deleteLint(request: unknown): Promise<WikiCallTransportResponse>;
  dismissLint(request: unknown): Promise<WikiTransportResponse>;
  reindexState(projectId?: string): Promise<WikiTransportResponse>;
  startReindex(request: unknown): Promise<WikiCallTransportResponse>;
  graphInsights(projectId?: string): Promise<WikiTransportResponse>;
  dismissGraphInsight(request: unknown): Promise<WikiTransportResponse>;
}

export function createWikiTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WikiTransport {
  return {
    status: () => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/status', 'GET', 'wiki:read'),
    projects: () => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/projects', 'GET', 'wiki:read'),
    projectTemplates: () => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project-templates', 'GET', 'wiki:read'),
    createProject: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project/create', 'POST', 'wiki:write', request),
    openProject: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project/open', 'POST', 'wiki:write', request),
    currentProject: () => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project/current', 'GET', 'wiki:read'),
    files: (projectId, directory) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/files', 'GET', 'wiki:read', undefined, filesQuery(projectId, directory)),
    navigation: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/navigation', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    deletePage: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/delete-page', request),
    readFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-file', 'POST', 'wiki:read', request),
    readBinaryFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-binary-file', 'POST', 'wiki:read', request),
    readSourcePreview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-source-preview', 'POST', 'wiki:read', request),
    writeFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/write-file', 'POST', 'wiki:write', request),
    search: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/search', 'POST', 'wiki:read', request),
    searchConfig: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/search-config', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    updateSearchConfig: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/search-config', 'POST', 'wiki:write', request),
    graph: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/graph', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    sourceWatchConfig: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-watch-config', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    updateSourceWatchConfig: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-watch-config', 'POST', 'wiki:write', request),
    rescanSources: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/rescan-sources', request),
    importSource: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/import-source', request),
    importFolder: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/import-folder', request),
    refreshSources: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/refresh-sources', request),
    applyGeneratedPages: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/apply-generated-pages', request),
    deleteSource: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/delete-source', request),
    callResult: async (request) => {
      if (!isRecord(request) || !hasExactKeys(request, ['callId'])
        || typeof request.callId !== 'string' || !/^[a-f0-9]{32}$/.test(request.callId)) {
        return { status: 400, body: { success: false, error: 'Wiki request is invalid' } };
      }
      const response = await send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/call-result', 'POST', 'wiki:write', request);
      if (response.status !== 200) return { status: response.status, body: response.body };
      try {
        const body = decodeWikiCallResult(response.body);
        if (body.callId === request.callId) return { status: 200, body };
      } catch { /* closed public boundary */ }
      return { status: 503, body: WIKI_UNAVAILABLE };
    },
    reviews: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/reviews', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    resolveReview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/review/resolve', 'POST', 'wiki:write', request),
    dismissReview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/review/dismiss', 'POST', 'wiki:write', request),
    clearResolvedReviews: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/reviews/clear-resolved', 'POST', 'wiki:write', request),
    sourceFiles: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-files', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    sourceTasks: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-tasks', 'POST', 'wiki:read', request),
    cancelSourceTask: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-task/cancel', 'POST', 'wiki:write', request),
    embedPage: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/embed-page', request),
    retrieveContext: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/retrieve-context', 'POST', 'wiki:read', request),
    historyList: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/list', 'POST', 'wiki:read', request),
    historyRestore: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/restore', request),
    historyStats: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/stats', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    historyConfig: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/config', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    updateHistoryConfig: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/config', 'POST', 'wiki:write', request),
    historyClear: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/history/clear', request),
    exportArchive: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project/export-archive', request),
    importArchive: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/project/import-archive', request),
    rebuildIndex: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/rebuild-index', request),
    detectDuplicates: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/detect', request),
    mergeDuplicates: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/merge', request),
    dedupState: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/state', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    cancelDedup: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/cancel', 'POST', 'wiki:write', request),
    retryDedup: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/retry', request),
    resumeDedup: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/resume', request),
    excludeDuplicates: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/dedup/exclude', 'POST', 'wiki:write', request),
    pageLinks: (projectId, relativePath) => {
      const query = projectQuery(projectId) ?? new URLSearchParams();
      if (relativePath) query.set('relativePath', relativePath);
      return send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/page-links', 'GET', 'wiki:read', undefined, query);
    },
    createMissingPage: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/missing-page/create', request),
    cancelMissingPage: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/missing-page/cancel', 'POST', 'wiki:write', request),
    generateSelection: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/selection/generate', request),
    selectionTask: async (projectId, taskId) => {
      const query = projectQuery(projectId) ?? new URLSearchParams();
      if (taskId) query.set('taskId', taskId);
      return selectionTaskResponse(
        await send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/selection/task', 'GET', 'wiki:read', undefined, query),
        projectId, taskId,
      );
    },
    cancelSelection: async (request) => selectionTaskResponse(
      await send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/selection/cancel', 'POST', 'wiki:write', request),
      isRecord(request) && typeof request.projectId === 'string' ? request.projectId : undefined,
      isRecord(request) && typeof request.taskId === 'string' ? request.taskId : undefined,
    ),
    applySelection: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/selection/apply', request),
    askQuestion: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/qa/ask', request),
    questionTask: (projectId, taskId) => {
      const query = projectQuery(projectId) ?? new URLSearchParams();
      if (taskId) query.set('taskId', taskId);
      return send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/qa/task', 'GET', 'wiki:read', undefined, query);
    },
    cancelQuestion: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/qa/cancel', 'POST', 'wiki:write', request),
    saveQuestion: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/qa/save', request),
    lintConfig: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/config', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    updateLintConfig: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/config', 'POST', 'wiki:write', request),
    lintState: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/state', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    runLint: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/run', request),
    cancelLint: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/cancel', 'POST', 'wiki:write', request),
    fixLint: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/fix', request),
    reviewLint: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/review', request),
    deleteLint: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/delete', request),
    dismissLint: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/lint/dismiss', 'POST', 'wiki:write', request),
    reindexState: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/embedding/reindex', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    startReindex: (request) => sendCall(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/embedding/reindex', request),
    graphInsights: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/graph/insights', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    dismissGraphInsight: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/graph/insights/dismiss', 'POST', 'wiki:write', request),
  };
}

async function sendCall(
  runtimeHostTransportPort: number,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  path: string,
  body: unknown,
): Promise<WikiCallTransportResponse> {
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path,
    issuer,
    decision: {
      endpoint: path,
      scope: 'wiki:write',
      capability: WIKI_CAPABILITY,
      subject: WIKI_SUBJECT,
    },
    method: 'POST',
    fetcher,
    body,
  });
  if (response?.status === 202) {
    try { return { status: 202, body: decodeCallReceipt(response.body) }; } catch { /* closed public boundary */ }
  }
  if (response !== null && isWikiStatus(response.status) && response.status !== 200) {
    return { status: response.status, body: response.body };
  }
  return { status: 503, body: WIKI_UNAVAILABLE };
}

async function send(
  runtimeHostTransportPort: number,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  path: string,
  method: 'GET' | 'POST',
  scope: 'wiki:read' | 'wiki:write',
  body?: unknown,
  query?: URLSearchParams,
): Promise<WikiTransportResponse> {
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path,
    issuer,
    decision: {
      endpoint: path,
      scope,
      capability: WIKI_CAPABILITY,
      subject: WIKI_SUBJECT,
    },
    method,
    fetcher,
    ...(query === undefined ? {} : { query }),
    ...(method === 'GET' ? { emptyContentLength: true } : {}),
    ...(body === undefined ? {} : { body }),
  });
  if (response === null) return { status: 503, body: WIKI_UNAVAILABLE };
  if (!isWikiStatus(response.status)) return { status: 503, body: WIKI_UNAVAILABLE };
  return { status: response.status, body: response.body };
}

function selectionTaskResponse(response: WikiTransportResponse, projectId: string | undefined, taskId: string | undefined): WikiTransportResponse {
  if (response.status !== 200) return response;
  try {
    const body = decodeWikiSelectionTask(response.body);
    if (body.taskId === taskId && (projectId === undefined || body.projectId === projectId)) {
      return { status: 200, body };
    }
  } catch { /* closed public boundary */ }
  return { status: 503, body: WIKI_UNAVAILABLE };
}

function filesQuery(projectId: string | undefined, directory: string | undefined): URLSearchParams | undefined {
  const query = new URLSearchParams();
  if (projectId) query.set('projectId', projectId);
  if (directory) query.set('directory', directory);
  return query.size > 0 ? query : undefined;
}

function projectQuery(projectId: string | undefined): URLSearchParams | undefined {
  return projectId ? new URLSearchParams({ projectId }) : undefined;
}

function isWikiStatus(status: number): status is WikiTransportResponse['status'] {
  return status === 200 || status === 400 || status === 404 || status === 409 || status === 422 || status === 503;
}
