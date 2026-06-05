import { capabilityRoutes } from '../../api/routes/capability-routes';
import { runtimeTopologyRoutes } from '../../api/routes/runtime-topology-routes';
import { sessionRoutes } from '../../api/routes/session-routes';
import type { AgentRuntimeApplicationService } from '../../application/agent-runtime/agent-runtime-application-service';
import type { SessionRuntimeService } from '../../application/sessions/service';
import type { RuntimeHostRouteRegistry } from '../route-registry';

export interface SessionRouteServices {
  readonly agentRuntimeService: AgentRuntimeApplicationService;
  readonly sessionRuntimeService: SessionRuntimeService;
}

export function registerSessionRoutes(
  routes: RuntimeHostRouteRegistry,
  services: SessionRouteServices,
): void {
  routes.registerDefinitions('session', sessionRoutes, services.sessionRuntimeService);
  routes.registerDefinitions('capabilities', capabilityRoutes, services.agentRuntimeService);
  routes.registerDefinitions('runtimeTopology', runtimeTopologyRoutes, services.agentRuntimeService);
}
