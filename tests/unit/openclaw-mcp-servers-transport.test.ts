import { describe, expect, it, vi } from 'vitest';
import { createOpenClawMcpServersTransport } from '../../electron/main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers';

const listRequest = {
  id: 'openclaw.mcpServers',
  operationId: 'openClawMcpServers.list',
  scope: { kind: 'openclaw-mcp-servers' },
  target: { kind: 'openclaw-mcp-servers' },
  input: { kind: 'list' },
} as const;


describe('OpenClaw MCP servers sealed transport', () => {
  it('signs only the OpenClaw MCP servers capability tuple', async () => {
    const signDecision = vi.fn(() => 'decision');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ servers: [] }), { status: 200 }));
    const transport = createOpenClawMcpServersTransport({ signDecision } as never, 43123, fetcher as never);

    await expect(transport.execute(listRequest)).resolves.toEqual({ status: 200, body: { servers: [] } });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/openclaw/mcp-servers',
      scope: 'openclaw:mcp-servers',
      capability: 'openClawMcpServers.list',
      subject: 'openclaw-mcp-servers',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:43123/api/openclaw/mcp-servers', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer decision' }),
    }));
  });

  it.each(['command', 'args', 'env', 'url', 'path'])('rejects MCP server summaries containing private %s fields', async (field) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        serverId: 'filesystem',
        displayName: 'Filesystem',
        kind: 'mcp-stdio',
        source: 'openclaw',
        enabled: true,
        managed: true,
        editable: false,
        removable: false,
        [field]: field === 'args' ? ['private'] : 'private',
      }],
    }), { status: 200 }));
    const transport = createOpenClawMcpServersTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute(listRequest)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'OpenClaw MCP servers are unavailable' },
    });
  });

  it('projects only safe MCP server summary fields', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        serverId: 'browser',
        connectorId: 'connector-1',
        displayName: 'Browser',
        description: 'Browser tools',
        kind: 'mcp-http',
        source: 'preset',
        enabled: true,
        managed: true,
        editable: false,
        removable: false,
      }],
    }), { status: 200 }));
    const transport = createOpenClawMcpServersTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute(listRequest)).resolves.toEqual({
      status: 200,
      body: {
        servers: [{
          serverId: 'browser',
          connectorId: 'connector-1',
          displayName: 'Browser',
          description: 'Browser tools',
          kind: 'mcp-http',
          source: 'preset',
          enabled: true,
          managed: true,
          editable: false,
          removable: false,
        }],
      },
    });
  });

  it('rejects session status requests without dispatching', async () => {
    const fetcher = vi.fn();
    const transport = createOpenClawMcpServersTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...listRequest,
      operationId: 'openClawMcpServers.sessionStatus',
      input: { kind: 'sessionStatus' },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'OpenClaw MCP servers request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
