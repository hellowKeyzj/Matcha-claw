import {
  badRequest,
  type RuntimeRouteDefinition,
} from './route-utils';

interface FileRouteDeps {
  fileService: FileRouteService;
}

interface FileRouteService {
  readText(payload: unknown): Promise<unknown>;
  readBinary(payload: unknown): Promise<unknown>;
  stat(payload: unknown): Promise<unknown>;
  listDir(payload: unknown): Promise<unknown>;
  thumbnails(payload: unknown): Promise<unknown>;
}

const LEGACY_FILE_ROUTE_REJECTION = 'Legacy file route is disabled; use /api/capabilities/execute with a workspace-file target';

function rejectedFileRoute(path: string): RuntimeRouteDefinition<FileRouteDeps> {
  return {
    method: 'POST',
    path,
    handle: () => badRequest(LEGACY_FILE_ROUTE_REJECTION),
  };
}

export const fileRoutes: readonly RuntimeRouteDefinition<FileRouteDeps>[] = [
  rejectedFileRoute('/api/files/read-text'),
  rejectedFileRoute('/api/files/read-binary'),
  rejectedFileRoute('/api/files/stat'),
  rejectedFileRoute('/api/files/list-dir'),
  rejectedFileRoute('/api/files/thumbnails'),
  rejectedFileRoute('/api/files/write-text'),
  rejectedFileRoute('/api/files/stage-paths'),
  rejectedFileRoute('/api/files/stage-buffer'),
  rejectedFileRoute('/api/files/thumbnail'),
] as const;
