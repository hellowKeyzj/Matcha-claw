import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WikiTransport } from '../../main/runtime-host-delivery/transport/wiki';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { success: false, error: 'Wiki request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Wiki is unavailable' } as const;

const WIKI_ROUTES = {
  '/api/wiki/status': { method: 'GET', action: 'status' },
  '/api/wiki/projects': { method: 'GET', action: 'projects' },
  '/api/wiki/project-templates': { method: 'GET', action: 'projectTemplates' },
  '/api/wiki/project/create': { method: 'POST', action: 'createProject' },
  '/api/wiki/project/open': { method: 'POST', action: 'openProject' },
  '/api/wiki/project/current': { method: 'GET', action: 'currentProject' },
  '/api/wiki/files': { method: 'GET', action: 'files' },
  '/api/wiki/navigation': { method: 'GET', action: 'navigation' },
  '/api/wiki/delete-page': { method: 'POST', action: 'deletePage' },
  '/api/wiki/read-file': { method: 'POST', action: 'readFile' },
  '/api/wiki/read-binary-file': { method: 'POST', action: 'readBinaryFile' },
  '/api/wiki/read-source-preview': { method: 'POST', action: 'readSourcePreview' },
  '/api/wiki/write-file': { method: 'POST', action: 'writeFile' },
  '/api/wiki/search': { method: 'POST', action: 'search' },
  '/api/wiki/graph': { method: 'GET', action: 'graph' },
  '/api/wiki/rescan-sources': { method: 'POST', action: 'rescanSources' },
  '/api/wiki/import-source': { method: 'POST', action: 'importSource' },
  '/api/wiki/import-folder': { method: 'POST', action: 'importFolder' },
  '/api/wiki/refresh-sources': { method: 'POST', action: 'refreshSources' },
  '/api/wiki/apply-generated-pages': { method: 'POST', action: 'applyGeneratedPages' },
  '/api/wiki/delete-source': { method: 'POST', action: 'deleteSource' },
  '/api/wiki/call-result': { method: 'POST', action: 'callResult' },
  '/api/wiki/reviews': { method: 'GET', action: 'reviews' },
  '/api/wiki/review/resolve': { method: 'POST', action: 'resolveReview' },
  '/api/wiki/review/dismiss': { method: 'POST', action: 'dismissReview' },
  '/api/wiki/reviews/clear-resolved': { method: 'POST', action: 'clearResolvedReviews' },
  '/api/wiki/source-files': { method: 'GET', action: 'sourceFiles' },
  '/api/wiki/source-tasks': { method: 'POST', action: 'sourceTasks' },
  '/api/wiki/source-task/cancel': { method: 'POST', action: 'cancelSourceTask' },
  '/api/wiki/embed-page': { method: 'POST', action: 'embedPage' },
  '/api/wiki/retrieve-context': { method: 'POST', action: 'retrieveContext' },
  '/api/wiki/history/list': { method: 'POST', action: 'historyList' },
  '/api/wiki/history/restore': { method: 'POST', action: 'historyRestore' },
  '/api/wiki/history/stats': { method: 'GET', action: 'historyStats' },
  '/api/wiki/history/clear': { method: 'POST', action: 'historyClear' },
  '/api/wiki/project/export-archive': { method: 'POST', action: 'exportArchive' },
  '/api/wiki/project/import-archive': { method: 'POST', action: 'importArchive' },
  '/api/wiki/rebuild-index': { method: 'POST', action: 'rebuildIndex' },
  '/api/wiki/dedup/detect': { method: 'POST', action: 'detectDuplicates' },
  '/api/wiki/dedup/merge': { method: 'POST', action: 'mergeDuplicates' },
  '/api/wiki/dedup/state': { method: 'GET', action: 'dedupState' },
  '/api/wiki/dedup/cancel': { method: 'POST', action: 'cancelDedup' },
  '/api/wiki/dedup/retry': { method: 'POST', action: 'retryDedup' },
  '/api/wiki/dedup/resume': { method: 'POST', action: 'resumeDedup' },
  '/api/wiki/dedup/exclude': { method: 'POST', action: 'excludeDuplicates' },
  '/api/wiki/page-links': { method: 'GET', action: 'pageLinks' },
  '/api/wiki/missing-page/create': { method: 'POST', action: 'createMissingPage' },
  '/api/wiki/missing-page/cancel': { method: 'POST', action: 'cancelMissingPage' },
  '/api/wiki/selection/generate': { method: 'POST', action: 'generateSelection' },
  '/api/wiki/selection/task': { method: 'GET', action: 'selectionTask' },
  '/api/wiki/selection/cancel': { method: 'POST', action: 'cancelSelection' },
  '/api/wiki/selection/apply': { method: 'POST', action: 'applySelection' },
  '/api/wiki/qa/ask': { method: 'POST', action: 'askQuestion' },
  '/api/wiki/qa/task': { method: 'GET', action: 'questionTask' },
  '/api/wiki/qa/cancel': { method: 'POST', action: 'cancelQuestion' },
  '/api/wiki/qa/save': { method: 'POST', action: 'saveQuestion' },
  '/api/wiki/lint/state': { method: 'GET', action: 'lintState' },
  '/api/wiki/lint/run': { method: 'POST', action: 'runLint' },
  '/api/wiki/lint/cancel': { method: 'POST', action: 'cancelLint' },
  '/api/wiki/lint/fix': { method: 'POST', action: 'fixLint' },
  '/api/wiki/lint/review': { method: 'POST', action: 'reviewLint' },
  '/api/wiki/lint/delete': { method: 'POST', action: 'deleteLint' },
  '/api/wiki/lint/dismiss': { method: 'POST', action: 'dismissLint' },
  '/api/wiki/graph/insights': { method: 'GET', action: 'graphInsights' },
  '/api/wiki/graph/insights/dismiss': { method: 'POST', action: 'dismissGraphInsight' },
} as const satisfies Record<string, { method: 'GET' | 'POST'; action: keyof WikiTransport }>;

export async function handleWikiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: WikiTransport,
): Promise<boolean> {
  const route = WIKI_ROUTES[url.pathname as keyof typeof WIKI_ROUTES];
  if (url.pathname === '/api/wiki/source-watch-config' || url.pathname === '/api/wiki/search-config'
    || url.pathname === '/api/wiki/history/config' || url.pathname === '/api/wiki/lint/config'
    || url.pathname === '/api/wiki/embedding/reindex') {
    if (req.method === 'GET') {
      try {
        const projectId = url.searchParams.get('projectId')?.trim() || undefined;
        const response = url.pathname === '/api/wiki/search-config'
          ? await transport.searchConfig(projectId)
          : url.pathname === '/api/wiki/history/config'
            ? await transport.historyConfig(projectId)
            : url.pathname === '/api/wiki/lint/config'
              ? await transport.lintConfig(projectId)
              : url.pathname === '/api/wiki/embedding/reindex'
                ? await transport.reindexState(projectId)
                : await transport.sourceWatchConfig(projectId);
        sendJson(res, response.status, response.body);
      } catch {
        sendJson(res, 503, UNAVAILABLE);
      }
      return true;
    }
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await parseJsonBody<unknown>(req);
      } catch {
        sendJson(res, 400, INVALID);
        return true;
      }
      try {
        const response = url.pathname === '/api/wiki/search-config'
          ? await transport.updateSearchConfig(body)
          : url.pathname === '/api/wiki/history/config'
            ? await transport.updateHistoryConfig(body)
            : url.pathname === '/api/wiki/lint/config'
              ? await transport.updateLintConfig(body)
              : url.pathname === '/api/wiki/embedding/reindex'
                ? await transport.startReindex(body)
                : await transport.updateSourceWatchConfig(body);
        sendJson(res, response.status, response.body);
      } catch {
        sendJson(res, 503, UNAVAILABLE);
      }
      return true;
    }
    return false;
  }
  if (!route || req.method !== route.method) return false;

  try {
    if (route.method === 'GET') {
      const projectId = url.searchParams.get('projectId')?.trim() || undefined;
      const response = route.action === 'files'
        ? await transport.files(projectId, url.searchParams.get('directory') ?? undefined)
        : route.action === 'graph' || route.action === 'graphInsights' || route.action === 'navigation'
          ? await transport[route.action](projectId)
          : route.action === 'sourceFiles'
            ? await transport.sourceFiles(projectId)
            : route.action === 'reviews'
              ? await transport.reviews(projectId)
              : route.action === 'historyStats'
                ? await transport.historyStats(projectId)
                : route.action === 'pageLinks'
                  ? await transport.pageLinks(projectId, url.searchParams.get('relativePath') ?? undefined)
                  : route.action === 'lintState' || route.action === 'dedupState'
                  ? await transport[route.action](projectId)
                  : route.action === 'questionTask' || route.action === 'selectionTask'
                    ? await transport[route.action](projectId, url.searchParams.get('taskId') ?? undefined)
                    : await (transport[route.action] as () => Promise<{ status: number; body: unknown }>)();
      sendJson(res, response.status, response.body);
      return true;
    }

    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
    const response = await (transport[route.action] as (request: unknown) => Promise<{ status: number; body: unknown }>)(body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
