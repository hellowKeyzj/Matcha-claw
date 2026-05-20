import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface SkillsRouteDeps {
  skillsService: SkillsRouteService;
}

interface SkillsRouteService {
  status(): unknown;
  refreshStatus(): Promise<unknown>;
  updateConfig(payload: unknown): Promise<ApplicationResponse>;
  updateState(payload: unknown): Promise<ApplicationResponse>;
  updateBatchState(payload: unknown): Promise<ApplicationResponse>;
  importLocal(payload: unknown): ApplicationResponse;
  exportBundles(payload: unknown): Promise<unknown>;
  importBundles(payload: unknown): Promise<ApplicationResponse>;
  effective(): Promise<unknown>;
  readmePreview(payload: unknown): Promise<ApplicationResponse>;
}

export const skillsRoutes: readonly RuntimeRouteDefinition<SkillsRouteDeps>[] = [
  { method: 'GET', path: '/api/skills/status', handle: (_context, deps) => routeResponder.value(() => deps.skillsService.status()) },
  { method: 'POST', path: '/api/skills/status/refresh', handle: (_context, deps) => routeResponder.value(() => deps.skillsService.refreshStatus()) },
  { method: 'PUT', path: '/api/skills/config', handle: (context, deps) => routeResponder.result(() => deps.skillsService.updateConfig(context.payload)) },
  { method: 'PUT', path: '/api/skills/state', handle: (context, deps) => routeResponder.result(() => deps.skillsService.updateState(context.payload)) },
  { method: 'PUT', path: '/api/skills/state/batch', handle: (context, deps) => routeResponder.result(() => deps.skillsService.updateBatchState(context.payload)) },
  { method: 'POST', path: '/api/skills/import-local', handle: (context, deps) => routeResponder.result(() => deps.skillsService.importLocal(context.payload)) },
  { method: 'POST', path: '/api/skills/bundles/export', handle: (context, deps) => routeResponder.value(() => deps.skillsService.exportBundles(context.payload)) },
  { method: 'POST', path: '/api/skills/bundles/import', handle: (context, deps) => routeResponder.result(() => deps.skillsService.importBundles(context.payload)) },
  { method: 'GET', path: '/api/skills/effective', handle: (_context, deps) => routeResponder.value(() => deps.skillsService.effective()) },
  { method: 'POST', path: '/api/skills/readme', handle: (context, deps) => routeResponder.result(() => deps.skillsService.readmePreview(context.payload)) },
] as const;

