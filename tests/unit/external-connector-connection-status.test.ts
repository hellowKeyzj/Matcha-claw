import { describe, expect, it, vi } from 'vitest';
import { ExternalConnectorConnectionProbeService } from '../../runtime-host/application/external-connectors/external-connector-connection-status';

function createProbe(httpClient: { request: ReturnType<typeof vi.fn> } = { request: vi.fn() }) {
  let now = 1000;
  return new ExternalConnectorConnectionProbeService({
    httpClient,
    clock: {
      nowMs: () => {
        now += 10;
        return now;
      },
      toIsoString: (ms) => `iso:${ms}`,
    },
  });
}

describe('ExternalConnectorConnectionProbeService', () => {
  it('marks disabled connectors without probing', async () => {
    const httpClient = { request: vi.fn() };
    const probe = createProbe(httpClient);

    await expect(probe.probe({ id: 'docs', kind: 'mcp-http', enabled: false, url: 'https://mcp.example.com' })).resolves.toEqual({
      connectorId: 'docs',
      resultType: 'disabled',
      checkedAt: 'iso:1010',
      reason: 'connector is disabled',
      safeProbe: false,
    });
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  it('does not mark system-runtime connected from a global runtime-host probe', async () => {
    const probe = createProbe();

    await expect(probe.probe({
      id: 'matcha',
      kind: 'mcp-stdio',
      command: 'matcha',
      enabled: true,
      mcpServerProgram: { source: 'system-runtime', programId: 'system-runtime:matcha' },
    })).resolves.toEqual({
      connectorId: 'matcha',
      resultType: 'unsupported',
      checkedAt: 'iso:1010',
      reason: 'system-runtime MCP is verified through downstream session status, not by a global runtime probe',
      safeProbe: false,
    });
  });

  it('does not execute arbitrary external stdio MCP connectors', async () => {
    const httpClient = { request: vi.fn() };
    const probe = createProbe(httpClient);

    await expect(probe.probe({ id: 'filesystem', kind: 'mcp-stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })).resolves.toEqual({
      connectorId: 'filesystem',
      resultType: 'unsupported',
      checkedAt: 'iso:1010',
      reason: 'external stdio MCP connectors require executing the configured command and are not probed automatically',
      safeProbe: false,
    });
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  it('probes streamable HTTP MCP connectors with initialize', async () => {
    const httpClient = {
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 'matcha-connector-probe', result: { protocolVersion: '2024-11-05' } }),
        text: async () => '',
      })),
    };
    const probe = createProbe(httpClient);

    await expect(probe.probe({ id: 'remote', kind: 'mcp-http', url: 'https://mcp.example.com' })).resolves.toMatchObject({
      connectorId: 'remote',
      resultType: 'connected',
      checkedAt: 'iso:1010',
      reason: 'MCP initialize probe succeeded',
      safeProbe: true,
    });
    expect(httpClient.request).toHaveBeenCalledWith('https://mcp.example.com', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('initialize'),
    }));
  });

  it('does not leak thrown request details into status reason', async () => {
    const httpClient = {
      request: vi.fn(async () => {
        throw new Error('Authorization: bearer secret-token');
      }),
    };
    const probe = createProbe(httpClient);

    await expect(probe.probe({ id: 'remote', kind: 'mcp-http', url: 'https://mcp.example.com' })).resolves.toMatchObject({
      connectorId: 'remote',
      resultType: 'disconnected',
      reason: 'probe request failed',
      safeProbe: true,
    });
  });
});
