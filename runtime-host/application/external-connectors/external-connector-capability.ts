import type { ExternalConnectorService } from './external-connector-service';
import type { CapabilityOperationDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../capabilities/contracts/capability-router';

export const EXTERNAL_CONNECTOR_CAPABILITY_ID = 'external.connector';

export const externalConnectorCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'externalConnectors.list', title: 'List external connectors', targetKind: 'runtime-endpoint' },
  { id: 'externalConnectors.get', title: 'Get external connector', targetKind: 'runtime-endpoint' },
  { id: 'externalConnectors.upsert', title: 'Upsert external connector', targetKind: 'runtime-endpoint' },
  { id: 'externalConnectors.remove', title: 'Remove external connector', targetKind: 'runtime-endpoint' },
] as const;

export function createExternalConnectorCapabilityOperationRoutes(deps: {
  externalConnectorService: Pick<ExternalConnectorService, 'list' | 'get' | 'upsert' | 'remove'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: EXTERNAL_CONNECTOR_CAPABILITY_ID,
      operationId: 'externalConnectors.list',
      handle: () => deps.externalConnectorService.list(),
    },
    {
      capabilityId: EXTERNAL_CONNECTOR_CAPABILITY_ID,
      operationId: 'externalConnectors.get',
      handle: (context) => deps.externalConnectorService.get(context.domainInput),
    },
    {
      capabilityId: EXTERNAL_CONNECTOR_CAPABILITY_ID,
      operationId: 'externalConnectors.upsert',
      handle: (context) => deps.externalConnectorService.upsert(context.domainInput),
    },
    {
      capabilityId: EXTERNAL_CONNECTOR_CAPABILITY_ID,
      operationId: 'externalConnectors.remove',
      handle: (context) => deps.externalConnectorService.remove(context.domainInput),
    },
  ];
}
