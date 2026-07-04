import {
  badRequest,
  notFound,
  ok,
  serverError,
  type ApplicationResponse,
} from '../common/application-response';
import type { ExternalConnectorConnectionProbeService } from './external-connector-connection-status';
import {
  readSessionIdentityPayload,
  type ExternalConnectorDownstreamStatus,
  type ExternalConnectorDownstreamStatusProvider,
} from './external-connector-downstream-status';
import { validateExternalConnectorSpec, type ExternalConnectorSpec } from './external-connector-model';
import type { ExternalConnectorRepository } from './external-connector-store';
import {
  MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID,
  MATCHA_SYSTEM_RUNTIME_MCP_PROGRAM_ID,
  type ExternalMcpServerProgramCatalog,
} from './external-mcp-server-program-catalog';

export type ExternalConnectorDownstreamSyncResult =
  | { readonly resultType: 'synced'; readonly value: unknown }
  | { readonly resultType: 'failed'; readonly error: string };

export interface ExternalConnectorProjectionPort {
  sync(): Promise<unknown>;
}

export interface ExternalConnectorProjectionSourcePort {
  listConnectorSpecs(): Promise<readonly ExternalConnectorSpec[]>;
}

const MATCHA_SYSTEM_RUNTIME_CONNECTOR: ExternalConnectorSpec = {
  id: MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID,
  kind: 'mcp-stdio',
  enabled: true,
  displayName: 'Matcha system runtime',
  description: 'Matcha-owned MCP stdio server exposed through the External Connector Platform.',
  command: 'matcha',
  args: ['system-runtime', 'mcp-stdio'],
  mcpServerProgram: {
    source: 'system-runtime',
    programId: MATCHA_SYSTEM_RUNTIME_MCP_PROGRAM_ID,
  },
  tags: ['system-runtime'],
};

export class ExternalConnectorService {
  private readonly projections: ExternalConnectorProjectionPort[] = [];
  private readonly downstreamStatusProviders: ExternalConnectorDownstreamStatusProvider[] = [];

  constructor(
    private readonly repository: Pick<ExternalConnectorRepository, 'list' | 'get' | 'upsert' | 'remove'>,
    private readonly mcpServerPrograms: Pick<ExternalMcpServerProgramCatalog, 'snapshot'>,
    private readonly connectionProbe: Pick<ExternalConnectorConnectionProbeService, 'probe' | 'unknown'>,
  ) {}

  registerProjection(projection: ExternalConnectorProjectionPort): void {
    this.projections.push(projection);
  }

  registerDownstreamStatusProvider(provider: ExternalConnectorDownstreamStatusProvider): void {
    this.downstreamStatusProviders.push(provider);
  }

  async list(): Promise<ApplicationResponse> {
    return ok({ connectors: await this.listConnectorSpecs() });
  }

  async listMcpServerPrograms(): Promise<ApplicationResponse> {
    return ok(await this.mcpServerPrograms.snapshot());
  }

  async listConnectionStatuses(): Promise<ApplicationResponse> {
    const connectors = await this.listConnectorSpecs();
    return ok({ statuses: await Promise.all(connectors.map((connector) => this.connectionProbe.probe(connector))) });
  }

  async probeConnectionStatus(payload: unknown): Promise<ApplicationResponse> {
    const connectorId = readConnectorId(payload);
    if (!connectorId) {
      return badRequest('connectorId is required');
    }
    const connector = await this.findConnectorSpec(connectorId);
    return ok({ status: connector ? await this.connectionProbe.probe(connector) : this.connectionProbe.unknown(connectorId) });
  }

  async listSessionDownstreamStatuses(payload: unknown): Promise<ApplicationResponse> {
    const sessionIdentity = readSessionIdentityPayload(payload);
    if (!sessionIdentity) {
      return badRequest('sessionIdentity is required');
    }
    const connectors = await this.listConnectorSpecs();
    const statuses: ExternalConnectorDownstreamStatus[] = [];
    for (const provider of this.downstreamStatusProviders) {
      statuses.push(...await provider.listStatuses(connectors, { sessionIdentity }));
    }
    return ok({ statuses });
  }

  async listConnectorSpecs(): Promise<readonly ExternalConnectorSpec[]> {
    const storedConnectors = await this.repository.list();
    return appendSystemRuntimeConnector(storedConnectors);
  }

  private async findConnectorSpec(connectorId: string): Promise<ExternalConnectorSpec | null> {
    if (connectorId === MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID) {
      return structuredClone(MATCHA_SYSTEM_RUNTIME_CONNECTOR);
    }
    return await this.repository.get(connectorId);
  }

  async get(payload: unknown): Promise<ApplicationResponse> {
    const connectorId = readConnectorId(payload);
    if (!connectorId) {
      return badRequest('connectorId is required');
    }
    if (connectorId === MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID) {
      return ok({ connector: structuredClone(MATCHA_SYSTEM_RUNTIME_CONNECTOR) });
    }
    const connector = await this.repository.get(connectorId);
    return connector ? ok({ connector }) : notFound(`External connector not found: ${connectorId}`);
  }

  async upsert(payload: unknown): Promise<ApplicationResponse> {
    const connector = readRecord(payload).connector ?? payload;
    const validation = validateExternalConnectorSpec(connector);
    if (validation.resultType === 'invalid') {
      return badRequest(validation.reason);
    }
    if (validation.connector.id === MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID) {
      return badRequest('Matcha system runtime connector is managed by the External Connector Platform');
    }

    try {
      const result = await this.repository.upsert(validation.connector);
      const downstreamSyncResults = await this.syncDownstreamProjections();
      return ok({ success: true, ...result, downstreamSyncResults });
    } catch (error) {
      return serverError(error instanceof Error ? error.message : 'External connector upsert failed');
    }
  }

  async remove(payload: unknown): Promise<ApplicationResponse> {
    const connectorId = readConnectorId(payload);
    if (!connectorId) {
      return badRequest('connectorId is required');
    }
    if (connectorId === MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID) {
      return badRequest('Matcha system runtime connector is managed by the External Connector Platform');
    }
    const removed = await this.repository.remove(connectorId);
    if (!removed) {
      return notFound(`External connector not found: ${connectorId}`);
    }
    const downstreamSyncResults = await this.syncDownstreamProjections();
    return ok({ success: true, connector: removed, downstreamSyncResults });
  }

  async syncDownstreamProjections(): Promise<readonly ExternalConnectorDownstreamSyncResult[]> {
    const results: ExternalConnectorDownstreamSyncResult[] = [];
    for (const projection of this.projections) {
      try {
        results.push({ resultType: 'synced', value: await projection.sync() });
      } catch (error) {
        results.push({
          resultType: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}

function appendSystemRuntimeConnector(connectors: readonly ExternalConnectorSpec[]): readonly ExternalConnectorSpec[] {
  return [
    ...connectors.filter((connector) => connector.id !== MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID),
    structuredClone(MATCHA_SYSTEM_RUNTIME_CONNECTOR),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function readConnectorId(payload: unknown): string {
  const body = readRecord(payload);
  const connectorId = typeof body.connectorId === 'string' ? body.connectorId.trim() : '';
  return connectorId || (typeof body.id === 'string' ? body.id.trim() : '');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
