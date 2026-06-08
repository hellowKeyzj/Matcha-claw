import { badRequest, type RuntimeRouteDefinition } from './route-utils';

interface SubagentRouteDeps {
  subagentService?: unknown;
}

const LEGACY_SUBAGENT_READ_ROUTE_REJECTION = 'Legacy subagent read route is disabled; use /api/capabilities/execute with an agent target';
const LEGACY_SUBAGENT_FILE_ROUTE_REJECTION = 'Legacy subagent file route is disabled; use /api/capabilities/execute with a subagent target';

function rejectedSubagentRoute(path: string, error: string): RuntimeRouteDefinition<SubagentRouteDeps> {
  return {
    method: 'POST',
    path,
    handle: () => badRequest(error),
  };
}

export const subagentRoutes: readonly RuntimeRouteDefinition<SubagentRouteDeps>[] = [
  rejectedSubagentRoute('/api/subagents/list', LEGACY_SUBAGENT_READ_ROUTE_REJECTION),
  rejectedSubagentRoute('/api/subagents/config/get', LEGACY_SUBAGENT_READ_ROUTE_REJECTION),
  rejectedSubagentRoute('/api/subagents/files/get', LEGACY_SUBAGENT_FILE_ROUTE_REJECTION),
  rejectedSubagentRoute('/api/subagents/files/list', LEGACY_SUBAGENT_FILE_ROUTE_REJECTION),
] as const;

