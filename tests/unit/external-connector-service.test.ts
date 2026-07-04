import { describe, expect, it } from 'vitest';
import { ExternalConnectorService } from '../../runtime-host/application/external-connectors/external-connector-service';
import { ExternalConnectorRepository, type ExternalConnectorStorePort } from '../../runtime-host/application/external-connectors/external-connector-store';
import type { ExternalConnectorSpec } from '../../runtime-host/application/external-connectors/external-connector-model';

class MemoryExternalConnectorStore implements ExternalConnectorStorePort {
  constructor(private connectors: readonly ExternalConnectorSpec[] = []) {}

  async readConnectors(): Promise<readonly ExternalConnectorSpec[]> {
    return this.connectors;
  }

  async writeConnectors(connectors: readonly ExternalConnectorSpec[]): Promise<void> {
    this.connectors = connectors;
  }
}

function createService(connectors: readonly ExternalConnectorSpec[] = []) {
  return new ExternalConnectorService(
    new ExternalConnectorRepository(new MemoryExternalConnectorStore(connectors)),
    { snapshot: async () => ({ programs: [], issues: [] }) },
    {
      probe: async (connector) => ({ connectorId: connector.id, resultType: 'unknown', safeProbe: false }),
      unknown: (connectorId) => ({ connectorId, resultType: 'unknown', safeProbe: false }),
    },
  );
}

describe('ExternalConnectorService', () => {
  it('lists Matcha system runtime as a managed connector source', async () => {
    const service = createService([{ id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' }]);

    await expect(service.listConnectorSpecs()).resolves.toEqual([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
      {
        id: 'matcha',
        kind: 'mcp-stdio',
        enabled: true,
        displayName: 'Matcha system runtime',
        description: 'Matcha-owned MCP stdio server exposed through the External Connector Platform.',
        command: 'matcha',
        args: ['system-runtime', 'mcp-stdio'],
        mcpServerProgram: {
          source: 'system-runtime',
          programId: 'system-runtime:matcha',
        },
        tags: ['system-runtime'],
      },
    ]);
  });

  it('returns connection statuses from runtime probes instead of deriving them from enabled', async () => {
    const service = new ExternalConnectorService(
      new ExternalConnectorRepository(new MemoryExternalConnectorStore([
        { id: 'enabled-but-down', kind: 'mcp-http', enabled: true, url: 'https://down.example.com' },
      ])),
      { snapshot: async () => ({ programs: [], issues: [] }) },
      {
        probe: async (connector) => ({
          connectorId: connector.id,
          resultType: connector.id === 'enabled-but-down' ? 'disconnected' : 'unsupported',
          checkedAt: '2026-06-26T00:00:00.000Z',
          safeProbe: connector.id === 'enabled-but-down',
        }),
        unknown: (connectorId) => ({ connectorId, resultType: 'unknown', safeProbe: false }),
      },
    );

    await expect(service.listConnectionStatuses()).resolves.toEqual({
      status: 200,
      data: {
        statuses: [
          {
            connectorId: 'enabled-but-down',
            resultType: 'disconnected',
            checkedAt: '2026-06-26T00:00:00.000Z',
            safeProbe: true,
          },
          {
            connectorId: 'matcha',
            resultType: 'unsupported',
            checkedAt: '2026-06-26T00:00:00.000Z',
            safeProbe: false,
          },
        ],
      },
    });
  });

  it('lists session downstream statuses from registered adapter providers', async () => {
    const service = createService([{ id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' }]);
    service.registerDownstreamStatusProvider({
      adapterId: 'test-adapter',
      listStatuses: async (connectors, context) => connectors.map((connector) => ({
        connectorId: connector.id,
        adapterId: 'test-adapter',
        targetKind: 'session',
        resultType: connector.id === 'docs' ? 'connected' : 'pending',
        details: { sessionKey: context.sessionIdentity.sessionKey },
      })),
    });

    await expect(service.listSessionDownstreamStatuses({
      sessionIdentity: {
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'agent-1',
        sessionKey: 'session-1',
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        statuses: [
          {
            connectorId: 'docs',
            adapterId: 'test-adapter',
            targetKind: 'session',
            resultType: 'connected',
            details: { sessionKey: 'session-1' },
          },
          {
            connectorId: 'matcha',
            adapterId: 'test-adapter',
            targetKind: 'session',
            resultType: 'pending',
            details: { sessionKey: 'session-1' },
          },
        ],
      },
    });

    await expect(service.listSessionDownstreamStatuses({})).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'sessionIdentity is required' },
    });
  });

  it('probes a single connector and returns unknown for missing connector ids', async () => {
    const service = new ExternalConnectorService(
      new ExternalConnectorRepository(new MemoryExternalConnectorStore([
        { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
      ])),
      { snapshot: async () => ({ programs: [], issues: [] }) },
      {
        probe: async (connector) => ({ connectorId: connector.id, resultType: 'connected', safeProbe: true }),
        unknown: (connectorId) => ({ connectorId, resultType: 'unknown', safeProbe: false }),
      },
    );

    await expect(service.probeConnectionStatus({ connectorId: 'docs' })).resolves.toEqual({
      status: 200,
      data: { status: { connectorId: 'docs', resultType: 'connected', safeProbe: true } },
    });
    await expect(service.probeConnectionStatus({ connectorId: 'missing' })).resolves.toEqual({
      status: 200,
      data: { status: { connectorId: 'missing', resultType: 'unknown', safeProbe: false } },
    });
    await expect(service.probeConnectionStatus({})).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'connectorId is required' },
    });
  });

  it('does not allow mutating the managed system runtime connector', async () => {
    const service = createService();

    await expect(service.upsert({
      id: 'matcha',
      kind: 'mcp-stdio',
      command: 'custom',
    })).resolves.toEqual({
      status: 400,
      data: {
        success: false,
        error: 'Matcha system runtime connector is managed by the External Connector Platform',
      },
    });

    await expect(service.remove({ connectorId: 'matcha' })).resolves.toEqual({
      status: 400,
      data: {
        success: false,
        error: 'Matcha system runtime connector is managed by the External Connector Platform',
      },
    });
  });
});
