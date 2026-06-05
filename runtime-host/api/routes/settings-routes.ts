import {
  badRequest,
  decodeRouteParam,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface SettingsRouteDeps {
  settingsService: SettingsRouteService;
}

interface SettingsRouteService {
  getAll(): Promise<Record<string, unknown>>;
  getValue(key: string): Promise<unknown>;
}

export const settingsRoutes: readonly RuntimeRouteDefinition<SettingsRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/settings',
    handle: (_context, deps) => routeResponder.value(() => deps.settingsService.getAll()),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/(.+)$/,
    handle: (_context, deps, match) => {
      const key = decodeRouteParam(match.params[0]);
      return key
        ? routeResponder.value(() => deps.settingsService.getValue(key))
        : badRequest('settings key is required');
    },
  },
] as const;

