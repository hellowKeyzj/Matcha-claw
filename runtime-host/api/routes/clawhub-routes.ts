import {
  accepted,
  readRecord,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ClawHubRouteDeps {
  clawHubService: ClawHubRouteService;
}

interface ClawHubRouteService {
  search(body: Record<string, unknown>): Promise<unknown>;
  login(): Promise<unknown>;
  install(body: Record<string, unknown>): unknown;
  uninstall(body: Record<string, unknown>): unknown;
  openReadme(skillKeyOrSlug: string, slug?: string, baseDir?: string): Promise<unknown>;
  openPath(skillKeyOrSlug: string, slug?: string, baseDir?: string): Promise<unknown>;
}

function readSkillLocator(payload: unknown): {
  readonly skillKeyOrSlug: string;
  readonly slug?: string;
  readonly baseDir?: string;
} {
  const body = readRecord(payload);
  const slug = typeof body.slug === 'string' ? body.slug : undefined;
  return {
    skillKeyOrSlug: typeof body.skillKey === 'string' ? body.skillKey : (slug ?? ''),
    ...(slug ? { slug } : {}),
    ...(typeof body.baseDir === 'string' ? { baseDir: body.baseDir } : {}),
  };
}

export const clawHubRoutes: readonly RuntimeRouteDefinition<ClawHubRouteDeps>[] = [
  {
    method: 'POST',
    path: '/api/clawhub/search',
    handle: async (context, deps) => routeResponder.ok({
      success: true,
      results: await deps.clawHubService.search(readRecord(context.payload)),
    }),
  },
  { method: 'POST', path: '/api/clawhub/auth/login', handle: (_context, deps) => routeResponder.value(() => deps.clawHubService.login()) },
  { method: 'POST', path: '/api/clawhub/install', handle: (context, deps) => accepted(deps.clawHubService.install(readRecord(context.payload))) },
  { method: 'POST', path: '/api/clawhub/uninstall', handle: (context, deps) => accepted(deps.clawHubService.uninstall(readRecord(context.payload))) },
  {
    method: 'POST',
    path: '/api/clawhub/open-readme',
    handle: (context, deps) => {
      const locator = readSkillLocator(context.payload);
      return routeResponder.value(() => deps.clawHubService.openReadme(locator.skillKeyOrSlug, locator.slug, locator.baseDir));
    },
  },
  {
    method: 'POST',
    path: '/api/clawhub/open-path',
    handle: (context, deps) => {
      const locator = readSkillLocator(context.payload);
      return routeResponder.value(() => deps.clawHubService.openPath(locator.skillKeyOrSlug, locator.slug, locator.baseDir));
    },
  },
] as const;

