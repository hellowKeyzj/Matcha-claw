import type { RuntimeTopologySnapshot } from '../../shared/runtime-topology';
import { badRequest, routeResponder, type RuntimeRouteDefinition } from './route-utils';

interface RuntimeTopologyRouteService {
  snapshotRuntimeTopology: () => RuntimeTopologySnapshot;
  connectRuntimeConnectorEndpoint: (payload: unknown) => Promise<unknown>;
  disconnectRuntimeConnectorEndpoint: (payload: unknown) => Promise<unknown>;
}

const LEGACY_RUNTIME_CONNECTOR_ROUTE_REJECTION = 'Legacy runtime connector lifecycle route is disabled; use /api/capabilities/execute with a runtime-endpoint target';

export const runtimeTopologyRoutes: readonly RuntimeRouteDefinition<RuntimeTopologyRouteService>[] = [
  {
    method: 'GET',
    path: '/api/runtime-adapters/list',
    handle: (_context, service) => routeResponder.value(() => ({
      adapters: service.snapshotRuntimeTopology().adapters,
    }), (message) => ({ success: false, error: message })),
  },
  {
    method: 'GET',
    path: '/api/runtime-adapters/instances/list',
    handle: (_context, service) => routeResponder.value(() => ({
      instances: service.snapshotRuntimeTopology().adapterInstances,
    }), (message) => ({ success: false, error: message })),
  },
  {
    method: 'GET',
    path: '/api/runtime-connectors/list',
    handle: (_context, service) => routeResponder.value(() => ({
      connectors: service.snapshotRuntimeTopology().connectors,
    }), (message) => ({ success: false, error: message })),
  },
  {
    method: 'POST',
    path: '/api/runtime-connectors/connect',
    handle: () => badRequest(LEGACY_RUNTIME_CONNECTOR_ROUTE_REJECTION),
  },
  {
    method: 'POST',
    path: '/api/runtime-connectors/disconnect',
    handle: () => badRequest(LEGACY_RUNTIME_CONNECTOR_ROUTE_REJECTION),
  },
  {
    method: 'GET',
    path: '/api/runtime-endpoints/list',
    handle: (_context, service) => routeResponder.value(() => ({
      endpoints: service.snapshotRuntimeTopology().endpoints,
    }), (message) => ({ success: false, error: message })),
  },
] as const;
