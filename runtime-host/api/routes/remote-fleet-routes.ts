import type { RemoteFleetOperationId, RemoteFleetPort } from '../../application/remote-fleet';
import { routeResponder, sanitizeReadOnlyRouteResponse, type RuntimeRouteDefinition } from './route-utils';

const REMOTE_FLEET_ROUTE_FORBIDDEN_RESPONSE_FIELDS = ['plaintext'] as const;

interface RemoteFleetRouteDeps {
  readonly remoteFleetService: Pick<RemoteFleetPort, 'invoke'>;
}

const REMOTE_FLEET_ROUTE_OPERATIONS = [
  { method: 'GET', path: '/api/remote-fleet/snapshot', operationId: 'snapshot' },
  { method: 'GET', path: '/api/remote-fleet/metrics', operationId: 'metrics' },
  { method: 'POST', path: '/api/remote-fleet/register-connection', operationId: 'registerConnection' },
  { method: 'POST', path: '/api/remote-fleet/delete-connection', operationId: 'deleteConnection' },
  { method: 'POST', path: '/api/remote-fleet/register-environment', operationId: 'registerEnvironment' },
  { method: 'POST', path: '/api/remote-fleet/deploy-environment', operationId: 'deployEnvironment' },
  { method: 'POST', path: '/api/remote-fleet/delete-environment', operationId: 'deleteEnvironment' },
  { method: 'POST', path: '/api/remote-fleet/register', operationId: 'register' },
  { method: 'POST', path: '/api/remote-fleet/write-credential', operationId: 'writeCredential' },
  { method: 'POST', path: '/api/remote-fleet/remove-node', operationId: 'removeNode' },
  { method: 'POST', path: '/api/remote-fleet/probe', operationId: 'probe' },
  { method: 'POST', path: '/api/remote-fleet/probe-connection', operationId: 'probeConnection' },
  { method: 'POST', path: '/api/remote-fleet/install-agent', operationId: 'installAgent' },
  { method: 'POST', path: '/api/remote-fleet/revoke-agent', operationId: 'revokeAgent' },
  { method: 'POST', path: '/api/remote-fleet/drain-endpoint', operationId: 'drainEndpoint' },
  { method: 'POST', path: '/api/remote-fleet/retire-endpoint', operationId: 'retireEndpoint' },
  { method: 'POST', path: '/api/remote-fleet/terminal/open', operationId: 'openTerminalSession' },
  { method: 'POST', path: '/api/remote-fleet/terminal/reconnect', operationId: 'reconnectTerminalSession' },
  { method: 'POST', path: '/api/remote-fleet/terminal/close', operationId: 'closeTerminalSession' },
  { method: 'GET', path: '/api/remote-fleet/terminal/sessions', operationId: 'listTerminalSessions' },
  { method: 'GET', path: '/api/remote-fleet/list-commands', operationId: 'listCommands' },
  { method: 'GET', path: '/api/remote-fleet/list-audit-events', operationId: 'listAuditEvents' },
] satisfies readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly operationId: RemoteFleetOperationId;
}[];

export const remoteFleetRoutes: readonly RuntimeRouteDefinition<RemoteFleetRouteDeps>[] = REMOTE_FLEET_ROUTE_OPERATIONS.map((operation) => ({
  method: operation.method,
  path: operation.path,
  handle: (context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(
    await deps.remoteFleetService.invoke(operation.operationId, context.payload),
    REMOTE_FLEET_ROUTE_FORBIDDEN_RESPONSE_FIELDS,
  )),
}));
