import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleOpenClawMcpServersRoutes } from '../../electron/api/routes/openclaw-mcp-servers';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: vi.fn(),
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('OpenClaw MCP servers Host API route', () => {
  it('maps the Renderer list route to the OpenClaw MCP servers operation', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { servers: [] } });
    const result = response();

    await expect(handleOpenClawMcpServersRoutes(
      request({}, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/openclaw/mcp-servers'),
      { execute },
    )).resolves.toBe(true);

    expect(result.state).toEqual({ statusCode: 200, body: { servers: [] } });
    expect(execute).toHaveBeenCalledWith({
      id: 'openclaw.mcpServers',
      operationId: 'openClawMcpServers.list',
      scope: { kind: 'openclaw-mcp-servers' },
      target: { kind: 'openclaw-mcp-servers' },
      input: { kind: 'list' },
    });
  });

  it('does not own session status requests', async () => {
    const execute = vi.fn();
    const result = response();

    await expect(handleOpenClawMcpServersRoutes(
      request({ sessionIdentity: { kind: 'session' } }),
      result.raw as never,
      new URL('http://127.0.0.1/api/openclaw/mcp-servers/session-status'),
      { execute },
    )).resolves.toBe(false);

    expect(execute).not.toHaveBeenCalled();
  });
});
