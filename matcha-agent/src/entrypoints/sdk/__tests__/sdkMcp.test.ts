import { describe, expect, test } from 'bun:test'
import { createSdkMcpServer, handleSdkMcpMessage, tool } from '../sdkMcp.js'

describe('sdkMcp', () => {
  test('lists and calls in-process SDK tools', async () => {
    const echo = tool('echo', 'Echo input', { value: {} }, async args => ({
      content: [{ type: 'text', text: String(args.value) }],
    }))
    const server = createSdkMcpServer({
      name: 'local',
      version: '1.0.0',
      tools: [echo],
    })

    const list = await handleSdkMcpMessage([server], 'local', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(list).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo input',
            inputSchema: { value: {} },
            annotations: undefined,
          },
        ],
      },
    })

    const call = await handleSdkMcpMessage([server], 'local', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'ok' } },
    })
    expect(call).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
  })

  test('returns JSON-RPC errors instead of throwing for bad tool calls', async () => {
    const server = createSdkMcpServer({ name: 'local', tools: [] })
    const response = await handleSdkMcpMessage([server], 'local', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'missing', arguments: {} },
    })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Unknown SDK MCP tool: missing' },
    })
  })

  test('passes abort signal into tool handlers', async () => {
    const abortController = new AbortController()
    let observedSignal: AbortSignal | undefined
    const inspect = tool(
      'inspect',
      'Inspect signal',
      {},
      async (_args, extra) => {
        observedSignal = extra.signal
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    )
    const server = createSdkMcpServer({ name: 'local', tools: [inspect] })

    await handleSdkMcpMessage(
      [server],
      'local',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'inspect' },
      },
      abortController.signal,
    )

    expect(observedSignal).toBe(abortController.signal)
  })
})
