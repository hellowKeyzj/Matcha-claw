import {
  accepted,
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface PlatformRouteDeps {
  readonly platformService: PlatformRouteService;
}

interface PlatformRouteService {
  runtimeHealth(): Promise<unknown>;
  startRun(payload: unknown): Promise<unknown>;
  abortRun(payload: unknown): Promise<ApplicationResponse>;
  installNativeTool(payload: unknown): Promise<ApplicationResponse>;
  reconcileTools(): unknown;
  listTools(routeUrl: URL): Promise<unknown>;
  queryTools(payload: unknown): Promise<unknown>;
  upsertPlatformTools(payload: unknown): Promise<unknown>;
  setToolEnabled(payload: unknown): Promise<ApplicationResponse>;
  executeTool(payload: unknown): Promise<unknown>;
}

export const platformRoutes: readonly RuntimeRouteDefinition<PlatformRouteDeps>[] = [
  { method: 'GET', path: '/api/platform/runtime/health', handle: (_context, deps) => routeResponder.value(() => deps.platformService.runtimeHealth()) },
  { method: 'POST', path: '/api/platform/runtime/start-run', handle: (context, deps) => routeResponder.value(() => deps.platformService.startRun(context.payload)) },
  { method: 'POST', path: '/api/platform/runtime/abort-run', handle: (context, deps) => routeResponder.result(() => deps.platformService.abortRun(context.payload)) },
  { method: 'POST', path: '/api/platform/tools/install-native', handle: (context, deps) => routeResponder.result(() => deps.platformService.installNativeTool(context.payload)) },
  { method: 'POST', path: '/api/platform/tools/reconcile', handle: (_context, deps) => accepted(deps.platformService.reconcileTools()) },
  { method: 'GET', path: '/api/platform/tools', handle: (context, deps) => routeResponder.value(() => deps.platformService.listTools(context.routeUrl)) },
  { method: 'POST', path: '/api/platform/tools/query', handle: (context, deps) => routeResponder.value(() => deps.platformService.queryTools(context.payload)) },
  { method: 'POST', path: '/api/platform/tools/upsert-platform', handle: (context, deps) => routeResponder.value(() => deps.platformService.upsertPlatformTools(context.payload)) },
  { method: 'POST', path: '/api/platform/tools/set-enabled', handle: (context, deps) => routeResponder.result(() => deps.platformService.setToolEnabled(context.payload)) },
  { method: 'POST', path: '/api/platform/tools/execute', handle: (context, deps) => routeResponder.value(() => deps.platformService.executeTool(context.payload)) },
] as const;

