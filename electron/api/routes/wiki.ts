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
} as const satisfies Record<string, { method: 'GET' | 'POST'; action: keyof WikiTransport }>;

export async function handleWikiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: WikiTransport,
): Promise<boolean> {
  const route = WIKI_ROUTES[url.pathname as keyof typeof WIKI_ROUTES];
  if (url.pathname === '/api/wiki/source-watch-config') {
    if (req.method === 'GET') {
      try {
        const projectId = url.searchParams.get('projectId')?.trim() || undefined;
        const response = await transport.sourceWatchConfig(projectId);
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
        const response = await transport.updateSourceWatchConfig(body);
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
        : route.action === 'graph'
          ? await transport.graph(projectId)
          : route.action === 'sourceFiles'
            ? await transport.sourceFiles(projectId)
            : route.action === 'reviews'
              ? await transport.reviews(projectId)
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
