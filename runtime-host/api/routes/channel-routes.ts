import {
  badRequest,
  decodeRouteParam,
  routeResponder,
  sanitizeReadOnlyRouteResponse,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ChannelRouteDeps {
  channelService: ChannelRouteService;
}

interface ChannelRouteService {
  snapshot(): unknown;
  validateConfig(payload: unknown): Promise<unknown>;
  validateCredentials(payload: unknown): Promise<unknown>;
  getConfigValues(channelType: string, accountId?: string): Promise<unknown>;
  listPairingRequests(channelType: string, accountId?: string): Promise<ApplicationResponse>;
}

const channelValidationError = (message: string) => ({
  success: false,
  valid: false,
  errors: [message],
  warnings: [],
});

const LEGACY_CHANNEL_CONFIG_ROUTE_REJECTION = 'Legacy channel config read is disabled; use channel capability operations';

export const channelRoutes: readonly RuntimeRouteDefinition<ChannelRouteDeps>[] = [
  { method: 'GET', path: '/api/channels/snapshot', handle: (_context, deps) => routeResponder.value(() => deps.channelService.snapshot()) },
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
  {
    method: 'GET',
    pattern: /^\/api\/channels\/pairing\/([^/]+)$/,
    handle: (context, deps, match) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.channelService.listPairingRequests(
      decodeRouteParam(match.params[0]),
      context.routeUrl.searchParams.get('accountId') || undefined,
    ))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/channels\/config\/(.+)$/,
    handle: () => badRequest(LEGACY_CHANNEL_CONFIG_ROUTE_REJECTION),
  },
] as const;
