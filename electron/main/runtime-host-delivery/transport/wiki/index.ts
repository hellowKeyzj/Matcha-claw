import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sendLoopbackJson } from '../client';

const WIKI_CAPABILITY = 'wiki';
const WIKI_SUBJECT = 'wiki';
const WIKI_UNAVAILABLE = { success: false, error: 'Wiki is unavailable' } as const;

export type WikiTransportResponse = Readonly<{
  status: 200 | 400 | 404 | 409 | 422 | 503;
  body: unknown;
}>;

export interface WikiTransport {
  status(): Promise<WikiTransportResponse>;
  projects(): Promise<WikiTransportResponse>;
  projectTemplates(): Promise<WikiTransportResponse>;
  createProject(request: unknown): Promise<WikiTransportResponse>;
  openProject(request: unknown): Promise<WikiTransportResponse>;
  currentProject(): Promise<WikiTransportResponse>;
  files(projectId?: string, directory?: string): Promise<WikiTransportResponse>;
  readFile(request: unknown): Promise<WikiTransportResponse>;
  readBinaryFile(request: unknown): Promise<WikiTransportResponse>;
  readSourcePreview(request: unknown): Promise<WikiTransportResponse>;
  writeFile(request: unknown): Promise<WikiTransportResponse>;
  search(request: unknown): Promise<WikiTransportResponse>;
  graph(projectId?: string): Promise<WikiTransportResponse>;
  sourceWatchConfig(projectId?: string): Promise<WikiTransportResponse>;
  updateSourceWatchConfig(request: unknown): Promise<WikiTransportResponse>;
  rescanSources(request: unknown): Promise<WikiTransportResponse>;
  importSource(request: unknown): Promise<WikiTransportResponse>;
  importFolder(request: unknown): Promise<WikiTransportResponse>;
  refreshSources(request: unknown): Promise<WikiTransportResponse>;
  applyGeneratedPages(request: unknown): Promise<WikiTransportResponse>;
  deleteSource(request: unknown): Promise<WikiTransportResponse>;
  reviews(projectId?: string): Promise<WikiTransportResponse>;
  resolveReview(request: unknown): Promise<WikiTransportResponse>;
  dismissReview(request: unknown): Promise<WikiTransportResponse>;
  clearResolvedReviews(request: unknown): Promise<WikiTransportResponse>;
  sourceFiles(projectId?: string): Promise<WikiTransportResponse>;
  sourceTasks(request: unknown): Promise<WikiTransportResponse>;
  cancelSourceTask(request: unknown): Promise<WikiTransportResponse>;
  embedPage(request: unknown): Promise<WikiTransportResponse>;
  retrieveContext(request: unknown): Promise<WikiTransportResponse>;
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
    readFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-file', 'POST', 'wiki:read', request),
    readBinaryFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-binary-file', 'POST', 'wiki:read', request),
    readSourcePreview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/read-source-preview', 'POST', 'wiki:read', request),
    writeFile: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/write-file', 'POST', 'wiki:write', request),
    search: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/search', 'POST', 'wiki:read', request),
    graph: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/graph', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    sourceWatchConfig: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-watch-config', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    updateSourceWatchConfig: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-watch-config', 'POST', 'wiki:write', request),
    rescanSources: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/rescan-sources', 'POST', 'wiki:write', request),
    importSource: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/import-source', 'POST', 'wiki:write', request),
    importFolder: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/import-folder', 'POST', 'wiki:write', request),
    refreshSources: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/refresh-sources', 'POST', 'wiki:write', request),
    applyGeneratedPages: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/apply-generated-pages', 'POST', 'wiki:write', request),
    deleteSource: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/delete-source', 'POST', 'wiki:write', request),
    reviews: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/reviews', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    resolveReview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/review/resolve', 'POST', 'wiki:write', request),
    dismissReview: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/review/dismiss', 'POST', 'wiki:write', request),
    clearResolvedReviews: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/reviews/clear-resolved', 'POST', 'wiki:write', request),
    sourceFiles: (projectId) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-files', 'GET', 'wiki:read', undefined, projectQuery(projectId)),
    sourceTasks: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-tasks', 'POST', 'wiki:read', request),
    cancelSourceTask: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/source-task/cancel', 'POST', 'wiki:write', request),
    embedPage: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/embed-page', 'POST', 'wiki:write', request),
    retrieveContext: (request) => send(runtimeHostTransportPort, issuer, fetcher, '/api/wiki/retrieve-context', 'POST', 'wiki:read', request),
  };
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
