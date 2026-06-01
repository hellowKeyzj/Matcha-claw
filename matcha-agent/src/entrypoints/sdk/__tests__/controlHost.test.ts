import { describe, expect, test } from 'bun:test'
import type { SDKControlResponse } from '../controlTypes.js'
import { ControlHost } from '../controlHost.js'
import { createSdkMcpServer, tool } from '../sdkMcp.js'

describe('ControlHost', () => {
  test('routes permission requests to the SDK callback', async () => {
    const responses: SDKControlResponse[] = []
    const host = new ControlHost(
      {
        canUseTool: async request => ({
          behavior: 'deny',
          message: request.toolName,
        }),
      },
      response => responses.push(response),
    )

    await host.handleControlRequest({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: {},
        tool_use_id: 'tool-1',
      },
    })

    expect(responses).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { behavior: 'deny', message: 'Bash' },
        },
      },
    ])
  })

  test('wraps SDK MCP responses for StructuredIO', async () => {
    const responses: SDKControlResponse[] = []
    const server = createSdkMcpServer({
      name: 'local',
      tools: [
        tool('echo', 'Echo input', { value: {} }, async args => ({
          content: [{ type: 'text', text: String(args.value) }],
        })),
      ],
    })
    const host = new ControlHost({ sdkMcpServers: [server] }, response =>
      responses.push(response),
    )

    await host.handleControlRequest({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'mcp_message',
        server_name: 'local',
        message: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { value: 'ok' } },
        },
      },
    })

    expect(responses[0]?.response.subtype).toBe('success')
    if (responses[0]?.response.subtype !== 'success') return
    expect(responses[0].response.response).toEqual({
      mcp_response: {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })
  })

  test('cancels an active SDK MCP tool request', async () => {
    const responses: SDKControlResponse[] = []
    let observedSignal: AbortSignal | undefined
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const server = createSdkMcpServer({
      name: 'local',
      tools: [
        tool('wait', 'Wait until cancelled', {}, async (_args, extra) => {
          observedSignal = extra.signal
          await blocked
          return { content: [{ type: 'text', text: 'done' }] }
        }),
      ],
    })
    const host = new ControlHost({ sdkMcpServers: [server] }, response =>
      responses.push(response),
    )

    const pending = host.handleControlRequest({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'mcp_message',
        server_name: 'local',
        message: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wait' },
        },
      },
    })

    while (!observedSignal) await Promise.resolve()
    host.cancel({ type: 'control_cancel_request', request_id: 'req-1' })
    release()
    await pending

    expect(observedSignal.aborted).toBe(true)
    expect(responses).toEqual([])
  })
})
