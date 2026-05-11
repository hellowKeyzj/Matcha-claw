import {
  badRequest,
  decodeRouteParam,
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface SettingsRouteDeps {
  settingsService: SettingsRouteService;
}

interface SettingsRouteService {
  getAll(): Promise<Record<string, unknown>>;
  patch(payload: unknown): Promise<ApplicationResponse>;
  reset(): Promise<ApplicationResponse>;
  getValue(key: string): Promise<unknown>;
  setValue(key: string, payload: unknown): Promise<ApplicationResponse>;
}

export const settingsRoutes: readonly RuntimeRouteDefinition<SettingsRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/settings',
    handle: (_context, deps) => routeResponder.value(() => deps.settingsService.getAll()),
  },
  {
    method: 'PUT',
    path: '/api/settings',
    handle: (context, deps) => routeResponder.result(() => deps.settingsService.patch(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/settings/reset',
    handle: (_context, deps) => routeResponder.result(() => deps.settingsService.reset()),
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
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/(.+)$/,
    handle: (context, deps, match) => {
      const key = decodeRouteParam(match.params[0]);
      return key
        ? routeResponder.result(() => deps.settingsService.setValue(key, context.payload))
        : badRequest('settings key is required');
    },
  },
] as const;

