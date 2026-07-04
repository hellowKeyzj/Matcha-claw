import { describe, expect, it, vi } from 'vitest';
import { runSystemRuntimeMcpServerCommand } from '../../runtime-host/application/runtime-cli/system-runtime-mcp-server-command';

const runtimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;

const runtimeEndpointArguments = {
  runtimeKind: runtimeEndpoint.kind,
  runtimeAdapterId: runtimeEndpoint.runtimeAdapterId,
  runtimeInstanceId: runtimeEndpoint.runtimeInstanceId,
} as const;

function encodeJsonRpcMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function decodeJsonRpcMessages(output: string): unknown[] {
  const messages: unknown[] = [];
  let buffer = Buffer.from(output, 'utf8');
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      break;
    }
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      break;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number.parseInt(match[1], 10);
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')));
    buffer = buffer.subarray(bodyEnd);
  }
  return messages;
}

function createInput(messages: unknown[], options: { readonly framing?: 'content-length' | 'json-line' } = {}) {
  const handlers = new Map<string, ((value?: unknown) => void)[]>();
  const payload = options.framing === 'json-line'
    ? `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
    : messages.map(encodeJsonRpcMessage).join('');
  return {
    on(event: string, listener: (value?: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
      return this;
    },
    resume() {
      for (const listener of handlers.get('data') ?? []) {
        listener(payload);
      }
      for (const listener of handlers.get('end') ?? []) {
        listener();
      }
    },
  };
}

describe('system runtime MCP server command', () => {
  it('serves initialize and tools/list over MCP stdio framing without stderr output', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

    const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
      stdin: createInput([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]) as never,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.chunks).toEqual([]);
    const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: any }>;
    expect(responses[0].result.serverInfo.name).toBe('matcha');
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'team_node_event',
      'team_graph_patch',
      'team_graph_context',
    ]);
    const nodeEventTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === 'team_node_event');
    expect(nodeEventTool.description).toContain('complete/reject are terminal for that nodeExecutionId');
    expect(nodeEventTool.description).toContain('Do not invent the next attempt id');
    expect(nodeEventTool.inputSchema.required).toEqual(expect.arrayContaining(['summary']));
    expect(nodeEventTool.inputSchema.properties.summary.description).toContain('Required top-level concise factual summary');
    expect(nodeEventTool.inputSchema.properties.evidenceRefs.description).toContain('do not use kind:file');
    for (const propertyName of ['kind', 'summary', 'content', 'decision', 'assignments', 'evidenceRefs', 'artifactIds', 'metadata']) {
      expect(nodeEventTool.inputSchema.properties.result.properties[propertyName].description).toEqual(expect.any(String));
    }
    expect(nodeEventTool.inputSchema.properties.result.properties.assignments).toEqual(expect.objectContaining({
      type: 'array',
      items: expect.objectContaining({
        type: 'object',
        required: ['roleId', 'text'],
      }),
    }));
    const graphContextTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === 'team_graph_context');
    expect(graphContextTool.inputSchema.properties.runtimeKind.description).toContain('Flat runtime endpoint kind');
    expect(graphContextTool.inputSchema.required).toContain('runtimeKind');
    expect(graphContextTool.inputSchema.allOf).toEqual([
      {
        anyOf: [
          { required: ['runtimeKind', 'runtimeAdapterId', 'runtimeInstanceId'] },
          { required: ['runtimeKind', 'protocolId', 'connectorId', 'endpointId'] },
        ],
      },
    ]);
    expect(graphContextTool.inputSchema.properties).not.toHaveProperty('runtimeEndpoint');
  });

  it('serves OpenClaw SDK newline-delimited JSON-RPC stdio framing', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

    const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
      stdin: createInput([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ], { framing: 'json-line' }) as never,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.chunks).toEqual([]);
    const responses = stdout.chunks.join('').trim().split('\n').map((line) => JSON.parse(line)) as Array<{ result: any }>;
    expect(responses[0].result.serverInfo.name).toBe('matcha');
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'team_node_event',
      'team_graph_patch',
      'team_graph_context',
    ]);
  });

  it('calls runtime-host dispatch for TeamRun node events', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { success: true, runId: 'run-1', accepted: true, record: { commandId: 'command-1' }, snapshot: { run: { runId: 'run-1' } } } }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
      const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

      const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
        stdin: createInput([{
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'team_node_event',
            arguments: {
              runId: 'run-1',
              teamId: 'team-1',
              ...runtimeEndpointArguments,
              nodeExecutionId: 'node-exec-1',
              event: 'complete',
              summary: 'done',
              result: {
                kind: 'work',
                summary: 'assigned',
                assignments: [{ roleId: 'operator', text: 'Do operator work.' }],
              },
              idempotencyKey: 'idem-1',
            },
          },
        }]) as never,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.chunks).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(url).toBe('http://127.0.0.1:3211/dispatch');
      expect(JSON.parse(init.body)).toMatchObject({
        method: 'POST',
        route: '/api/capabilities/execute',
        payload: {
          id: 'team.runtime',
          operationId: 'team.nodeEvent',
          scope: { kind: 'team-run', endpoint: runtimeEndpoint, runId: 'run-1', teamId: 'team-1' },
          target: { kind: 'team-run', runId: 'run-1', teamId: 'team-1' },
        },
      });
      const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: { content: Array<{ text: string }> } }>;
      expect(JSON.parse(responses[0].result.content[0].text)).toEqual({ success: true, runId: 'run-1', accepted: true });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('calls runtime-host dispatch for compact TeamRun graph context', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { fieldGuide: { graph: 'Compact graph topology.' }, run: { runId: 'run-1' }, graph: null } }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
      const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

      const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
        stdin: createInput([{
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'team_graph_context',
            arguments: {
              runId: 'run-1',
              teamId: 'team-1',
              ...runtimeEndpointArguments,
              nodeExecutionId: 'node-exec-1',
              view: 'current_node',
            },
          },
        }]) as never,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.chunks).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({
        payload: {
          id: 'team.runtime',
          operationId: 'team.graphContext',
          scope: { kind: 'team-run', endpoint: runtimeEndpoint, runId: 'run-1', teamId: 'team-1' },
          target: { kind: 'team-run', runId: 'run-1', teamId: 'team-1' },
          input: expect.objectContaining({ runId: 'run-1', nodeExecutionId: 'node-exec-1', view: 'current_node' }),
        },
      });
      const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: { content: Array<{ text: string }> } }>;
      expect(JSON.parse(responses[0].result.content[0].text)).toEqual({ fieldGuide: { graph: 'Compact graph topology.' }, run: { runId: 'run-1' }, graph: null });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('uses stdio runtime-host flags for dispatch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { success: true, runId: 'run-1', accepted: true, record: { commandId: 'command-1' }, snapshot: { run: { runId: 'run-1' } } } }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
      const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

      const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio', '--runtime-host-url', 'http://runtime.local/', '--timeout-ms', '1000'], {
        stdin: createInput([{
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'team_graph_patch',
            arguments: {
              runId: 'run-1',
              ...runtimeEndpointArguments,
              summary: 'patch',
              patch: { operations: [] },
              idempotencyKey: 'idem-1',
            },
          },
        }]) as never,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.chunks).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe('http://runtime.local/dispatch');
      const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: { content: Array<{ text: string }> } }>;
      expect(JSON.parse(responses[0].result.content[0].text)).toEqual({ success: true, runId: 'run-1', accepted: true });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('rejects TeamRun tool calls without explicit flat runtime endpoint fields', async () => {
    const fetchMock = vi.fn();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
      const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

      const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
        stdin: createInput([{
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'team_node_event',
            arguments: {
              runId: 'run-1',
              nodeExecutionId: 'node-exec-1',
              event: 'complete',
              summary: 'done',
              idempotencyKey: 'idem-1',
            },
          },
        }]) as never,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.chunks).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: { isError: boolean; content: Array<{ text: string }> } }>;
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain('runtimeKind is required');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('returns MCP tool errors without writing stderr', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: { code: 'NOT_FOUND', message: 'missing route' } }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
      const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };

      const exitCode = await runSystemRuntimeMcpServerCommand(['system-runtime', 'mcp-stdio'], {
        stdin: createInput([{
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'team_node_event',
            arguments: {
              runId: 'run-1',
              ...runtimeEndpointArguments,
              nodeExecutionId: 'node-exec-1',
              event: 'complete',
              summary: 'done',
              idempotencyKey: 'idem-1',
            },
          },
        }]) as never,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.chunks).toEqual([]);
      const responses = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ result: { isError: boolean; content: Array<{ text: string }> } }>;
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain('dispatchFailure status=404 code=NOT_FOUND');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
