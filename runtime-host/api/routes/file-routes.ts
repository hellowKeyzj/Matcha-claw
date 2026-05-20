import {
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface FileRouteDeps {
  fileService: FileRouteService;
}

interface FileRouteService {
  readText(payload: unknown): Promise<unknown>;
  writeText(payload: unknown): Promise<unknown>;
  readBinary(payload: unknown): Promise<unknown>;
  stat(payload: unknown): Promise<unknown>;
  listDir(payload: unknown): Promise<unknown>;
  stagePaths(payload: unknown): Promise<unknown>;
  stageBuffer(payload: unknown): Promise<unknown>;
  thumbnails(payload: unknown): Promise<unknown>;
}

export const fileRoutes: readonly RuntimeRouteDefinition<FileRouteDeps>[] = [
  { method: 'POST', path: '/api/files/read-text', handle: (context, deps) => routeResponder.value(() => deps.fileService.readText(context.payload)) },
  { method: 'POST', path: '/api/files/write-text', handle: (context, deps) => routeResponder.value(() => deps.fileService.writeText(context.payload)) },
  { method: 'POST', path: '/api/files/read-binary', handle: (context, deps) => routeResponder.value(() => deps.fileService.readBinary(context.payload)) },
  { method: 'POST', path: '/api/files/stat', handle: (context, deps) => routeResponder.value(() => deps.fileService.stat(context.payload)) },
  { method: 'POST', path: '/api/files/list-dir', handle: (context, deps) => routeResponder.value(() => deps.fileService.listDir(context.payload)) },
  { method: 'POST', path: '/api/files/stage-paths', handle: (context, deps) => routeResponder.value(() => deps.fileService.stagePaths(context.payload)) },
  { method: 'POST', path: '/api/files/stage-buffer', handle: (context, deps) => routeResponder.value(() => deps.fileService.stageBuffer(context.payload)) },
  { method: 'POST', path: '/api/files/thumbnails', handle: (context, deps) => routeResponder.value(() => deps.fileService.thumbnails(context.payload)) },
] as const;
