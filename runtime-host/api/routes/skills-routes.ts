import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface SkillsRouteDeps {
  skillsService: SkillsRouteService;
}

interface SkillsRouteService {
  status(): unknown;
  effective(): Promise<unknown>;
  readmePreview(payload: unknown): Promise<ApplicationResponse>;
}

export const skillsRoutes: readonly RuntimeRouteDefinition<SkillsRouteDeps>[] = [
  { method: 'GET', path: '/api/skills/status', handle: (_context, deps) => routeResponder.value(() => deps.skillsService.status()) },
  { method: 'GET', path: '/api/skills/effective', handle: (_context, deps) => routeResponder.value(() => deps.skillsService.effective()) },
  { method: 'POST', path: '/api/skills/readme', handle: (context, deps) => routeResponder.result(() => deps.skillsService.readmePreview(context.payload)) },
] as const;

