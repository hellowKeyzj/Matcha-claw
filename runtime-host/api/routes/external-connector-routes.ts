import { routeResponder, sanitizeReadOnlyRouteResponse, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface ExternalConnectorRouteDeps {
  externalConnectorService: ExternalConnectorRouteService;
}

interface ExternalConnectorRouteService {
  list(): Promise<ApplicationResponse>;
  listMcpServerPrograms(): Promise<ApplicationResponse>;
  listConnectionStatuses(): Promise<ApplicationResponse>;
  probeConnectionStatus(payload: unknown): Promise<ApplicationResponse>;
  listSessionDownstreamStatuses(payload: unknown): Promise<ApplicationResponse>;
  get(payload: unknown): Promise<ApplicationResponse>;
  upsert(payload: unknown): Promise<ApplicationResponse>;
  remove(payload: unknown): Promise<ApplicationResponse>;
}

export const externalConnectorRoutes: readonly RuntimeRouteDefinition<ExternalConnectorRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/external-connectors',
    handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.list())),
  },
  {
    method: 'GET',
    path: '/api/external-connectors/mcp-server-programs',
    handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.listMcpServerPrograms())),
  },
  {
    method: 'GET',
    path: '/api/external-connectors/status',
    handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.listConnectionStatuses())),
  },
  {
    method: 'POST',
    path: '/api/external-connectors/probe',
    handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.probeConnectionStatus(context.payload))),
  },
  {
    method: 'POST',
    path: '/api/external-connectors/session-status',
    handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.listSessionDownstreamStatuses(context.payload))),
  },
  {
    method: 'POST',
    path: '/api/external-connectors/get',
    handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.get(context.payload))),
  },
  {
    method: 'POST',
    path: '/api/external-connectors/upsert',
    handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.upsert(context.payload))),
  },
  {
    method: 'POST',
    path: '/api/external-connectors/remove',
    handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.externalConnectorService.remove(context.payload))),
  },
] as const;
