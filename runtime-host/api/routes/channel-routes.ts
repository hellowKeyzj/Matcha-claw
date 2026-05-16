import {
  decodeRouteParam,
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ChannelRouteDeps {
  channelService: ChannelRouteService;
}

interface ChannelRouteService {
  snapshot(): unknown;
  configured(): Promise<unknown>;
  validateConfig(payload: unknown): Promise<unknown>;
  validateCredentials(payload: unknown): Promise<unknown>;
  activate(payload: unknown): Promise<ApplicationResponse>;
  cancelSession(payload: unknown): Promise<ApplicationResponse>;
  connect(payload: unknown): Promise<ApplicationResponse>;
  disconnect(payload: unknown): Promise<ApplicationResponse>;
  requestQr(payload: unknown): Promise<ApplicationResponse>;
  getConfigValues(channelType: string, accountId?: string): Promise<unknown>;
  deleteConfig(channelType: string): ApplicationResponse;
}

const channelValidationError = (message: string) => ({
  success: false,
  valid: false,
  errors: [message],
  warnings: [],
});

export const channelRoutes: readonly RuntimeRouteDefinition<ChannelRouteDeps>[] = [
  { method: 'GET', path: '/api/channels/snapshot', handle: (_context, deps) => routeResponder.value(() => deps.channelService.snapshot()) },
  { method: 'GET', path: '/api/channels/configured', handle: (_context, deps) => routeResponder.value(() => deps.channelService.configured()) },
  {
    method: 'POST',
    path: '/api/channels/config/validate',
    handle: (context, deps) => routeResponder.value(
      () => deps.channelService.validateConfig(context.payload),
      channelValidationError,
    ),
  },
  {
    method: 'POST',
    path: '/api/channels/credentials/validate',
    handle: (context, deps) => routeResponder.value(
      () => deps.channelService.validateCredentials(context.payload),
      channelValidationError,
    ),
  },
  { method: 'POST', path: '/api/channels/activate', handle: (context, deps) => routeResponder.result(() => deps.channelService.activate(context.payload)) },
  { method: 'POST', path: '/api/channels/session/cancel', handle: (context, deps) => routeResponder.result(() => deps.channelService.cancelSession(context.payload)) },
  { method: 'POST', path: '/api/channels/connect', handle: (context, deps) => routeResponder.result(() => deps.channelService.connect(context.payload)) },
  { method: 'POST', path: '/api/channels/disconnect', handle: (context, deps) => routeResponder.result(() => deps.channelService.disconnect(context.payload)) },
  { method: 'POST', path: '/api/channels/request-qr', handle: (context, deps) => routeResponder.result(() => deps.channelService.requestQr(context.payload)) },
  {
    method: 'GET',
    pattern: /^\/api\/channels\/config\/(.+)$/,
    handle: (context, deps, match) => routeResponder.value(() => deps.channelService.getConfigValues(
      decodeRouteParam(match.params[0]),
      context.routeUrl.searchParams.get('accountId') || undefined,
    )),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/channels\/config\/(.+)$/,
    handle: (_context, deps, match) => routeResponder.result(() => deps.channelService.deleteConfig(
      decodeRouteParam(match.params[0]),
    )),
  },
] as const;

