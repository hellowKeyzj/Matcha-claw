import { AgentRuntimeApplicationService } from '../../application/agent-runtime/agent-runtime-application-service';
import { AgentRuntimeRegistry } from '../../application/agent-runtime/contracts/agent-runtime-registry';
import { createAgentRunCapabilityOperationRoutes } from '../../application/capabilities/agent/agent-run-capability';
import type {
  RuntimeAdapterRegistrationFactory,
  RuntimeConnectorRegistrationFactory,
} from '../../application/agent-runtime/contracts/runtime-endpoint-types';
import { CapabilityRouter, type CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import type { GatewayChatPort, GatewayRpcPort } from '../../application/gateway/gateway-runtime-port';
import type { RuntimeHostContainer } from '../container';

export interface AgentRuntimeModule {
  readonly application: AgentRuntimeApplicationService;
  readonly registry: AgentRuntimeRegistry;
}

export function registerAgentRuntimeModule(
  container: RuntimeHostContainer,
  gateway: () => GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>,
): void {
  container.register('agentRuntime.registry', (scope) => {
    const registry = new AgentRuntimeRegistry({ gateway });
    for (const factory of scope.resolveContributions<RuntimeAdapterRegistrationFactory>('runtime.adapterRegistrationFactories')) {
      for (const adapter of factory.create()) {
        registry.registerRuntimeAdapter(adapter);
      }
    }
    for (const factory of scope.resolveContributions<RuntimeConnectorRegistrationFactory>('runtime.connectorRegistrationFactories')) {
      for (const connector of factory.create()) {
        registry.registerProtocolConnector(connector);
      }
    }
    return registry;
  });
  container.register('agentRuntime.capabilityRouter', (scope) => new CapabilityRouter({
    getCapability: (descriptor) => scope.resolve<AgentRuntimeRegistry>('agentRuntime.registry').getCapability(descriptor),
    operations: () => [
      ...createAgentRunCapabilityOperationRoutes({
        gateway: gateway(),
      }),
      ...scope
        .resolveContributions<readonly CapabilityOperationRoute[]>('agentRuntime.capabilityOperationRoutes')
        .flat(),
    ],
  }));
  container.register('agentRuntime.application', (scope) => new AgentRuntimeApplicationService({
    agentRuntimeRegistry: scope.resolve('agentRuntime.registry'),
    capabilityRouter: scope.resolve('agentRuntime.capabilityRouter'),
  }));
}

export function resolveAgentRuntimeModule(container: RuntimeHostContainer): AgentRuntimeModule {
  return {
    application: container.resolve('agentRuntime.application'),
    registry: container.resolve('agentRuntime.registry'),
  };
}
