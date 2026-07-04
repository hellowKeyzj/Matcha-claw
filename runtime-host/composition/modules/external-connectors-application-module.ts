import { externalConnectorRoutes } from '../../api/routes/external-connector-routes';
import { ExternalConnectorConnectionProbeService } from '../../application/external-connectors/external-connector-connection-status';
import { ExternalConnectorJsonStore } from '../../application/external-connectors/external-connector-json-store';
import { ExternalConnectorRepository } from '../../application/external-connectors/external-connector-store';
import { ExternalConnectorService } from '../../application/external-connectors/external-connector-service';
import { ExternalMcpServerProgramCatalog } from '../../application/external-connectors/external-mcp-server-program-catalog';
import { createExternalConnectorCapabilityOperationRoutes } from '../../application/external-connectors/external-connector-capability';
import type {
  RuntimeClockPort,
  RuntimeDataRootPort,
  RuntimeFileSystemPort,
  RuntimeHttpClientPort,
  RuntimeSystemEnvironmentPort,
} from '../../application/common/runtime-ports';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import type { ApplicationServiceRegistry } from '../application-service-registry';
import type { RuntimeHostContainer } from '../container';
import type { RuntimeHostRouteRegistry } from '../route-registry';
import { EXTERNAL_CONNECTOR_SERVICE_TOKEN } from '../runtime-host-tokens';

export function registerExternalConnectorApplicationServices(
  container: RuntimeHostContainer,
  facades: ApplicationServiceRegistry,
): void {
  container.register('externalConnectors.store', (scope) => new ExternalConnectorJsonStore({
    runtimeData: scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('externalConnectors.repository', (scope) => new ExternalConnectorRepository(
    scope.resolve<ExternalConnectorJsonStore>('externalConnectors.store'),
  ));
  container.register('externalConnectors.mcpServerProgramCatalog', (scope) => new ExternalMcpServerProgramCatalog({
    environment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    runtimeData: scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('externalConnectors.connectionProbe', (scope) => new ExternalConnectorConnectionProbeService({
    httpClient: scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('externalConnectors.service', (scope) => new ExternalConnectorService(
    scope.resolve<ExternalConnectorRepository>('externalConnectors.repository'),
    scope.resolve<ExternalMcpServerProgramCatalog>('externalConnectors.mcpServerProgramCatalog'),
    scope.resolve<ExternalConnectorConnectionProbeService>('externalConnectors.connectionProbe'),
  ));
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => (
    createExternalConnectorCapabilityOperationRoutes({
      externalConnectorService: scope.resolve<ExternalConnectorService>('externalConnectors.service'),
    })
  ));
  facades.registerContainerFacade('external-connectors', EXTERNAL_CONNECTOR_SERVICE_TOKEN, container);
}

export function registerExternalConnectorRoutes(
  routes: RuntimeHostRouteRegistry,
  deps: {
    readonly externalConnectorService: ExternalConnectorService;
  },
): void {
  routes.registerDefinitions('external_connectors', externalConnectorRoutes, {
    externalConnectorService: deps.externalConnectorService,
  });
}
