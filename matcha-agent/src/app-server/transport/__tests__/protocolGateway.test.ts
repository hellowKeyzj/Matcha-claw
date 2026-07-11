import { describe, expect, test } from 'bun:test'
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerEventEnvelope,
} from '../../protocol/types.js'
import type { AppServerPorts, EventsSubscribeResult } from '../ports.js'
import { ProtocolGateway } from '../protocolGateway.js'

type TestPortsOverrides = Partial<
  Omit<AppServerPorts, 'session' | 'events' | 'approval' | 'models'>
> & {
  session?: Partial<AppServerPorts['session']>
  events?: Partial<AppServerPorts['events']>
  approval?: Partial<AppServerPorts['approval']>
  models?: Partial<AppServerPorts['models']>
}

function createTestPorts(overrides: TestPortsOverrides = {}): AppServerPorts {
  const base: AppServerPorts = {
    initialize: params => ({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      serverVersion: 'test-server',
      capabilities: {
        eventReplay: true,
        snapshots: true,
        approvals: true,
        sdkMessageEnvelope: true,
        blobStore: true,
        sessionTranscript: true,
      },
      clientName: params.clientName,
    }),
    session: {
      create: () => notImplemented('session.create'),
      load: () => notImplemented('session.load'),
      list: () => ({ sessions: [] }),
      close: () => notImplemented('session.close'),
      prompt: () => ({ runId: 'run-1' }),
      transcript: () => ({ lines: [] }),
      cancel: () => ({ cancelled: true }),
      snapshot: () => notImplemented('session.snapshot'),
      setModel: () => notImplemented('session.setModel'),
      setMode: () => notImplemented('session.setMode'),
    },
    events: {
      replay: params => ({
        events: [eventEnvelope(params.sessionId, params.afterSeq ?? 0)],
      }),
      subscribe: (clientId, params): EventsSubscribeResult => {
        if (clientId === undefined) return { resultType: 'clientRequired' }
        return {
          resultType: 'subscribed',
          clientId,
          sessionId: params.sessionId,
          ...(params.afterSeq !== undefined
            ? { afterSeq: params.afterSeq }
            : {}),
        }
      },
    },
    approval: {
      respond: () => ({ responded: true }),
    },
    models: {
      list: () => ({ models: ['opus'] }),
    },
  }

  return {
    ...base,
    ...overrides,
    session: { ...base.session, ...overrides.session },
    events: { ...base.events, ...overrides.events },
    approval: { ...base.approval, ...overrides.approval },
    models: { ...base.models, ...overrides.models },
  }
}

function eventEnvelope(sessionId: string, seq: number): AppServerEventEnvelope {
  return {
    eventId: `${sessionId}-${seq}`,
    sessionId,
    seq,
    createdAt: '2026-01-01T00:00:00.000Z',
    event: {
      type: 'message.delta',
      messageId: 'message-1',
      delta: 'hello',
    },
  }
}

function notImplemented(method: string): never {
  throw new Error(`Unexpected test call: ${method}`)
}

function parseResponse(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  return JSON.parse(raw)
}

describe('ProtocolGateway', () => {
  test('dispatches JSON-RPC requests through ports', async () => {
    const gateway = new ProtocolGateway(createTestPorts())

    const response = parseResponse(
      await gateway.handleTextMessage(
        'client-1',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'init-1',
          method: 'initialize',
          params: { clientName: 'test-client' },
        }),
      ),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'init-1',
      result: {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        serverVersion: 'test-server',
      },
    })
  })

  test('returns classified JSON-RPC errors for parse, method and params failures', async () => {
    const gateway = new ProtocolGateway(createTestPorts())

    expect(
      parseResponse(await gateway.handleTextMessage('client-1', '{')),
    ).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })

    expect(
      parseResponse(
        await gateway.handleTextMessage(
          'client-1',
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'missing.method' }),
        ),
      ),
    ).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found: missing.method' },
    })

    expect(
      parseResponse(
        await gateway.handleTextMessage(
          'client-1',
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'session.prompt',
            params: {},
          }),
        ),
      ),
    ).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32602, message: 'sessionId must be a non-empty string' },
    })
  })

  test('does not respond to notifications', async () => {
    const prompted: string[] = []
    const gateway = new ProtocolGateway(
      createTestPorts({
        session: {
          prompt: params => {
            prompted.push(params.prompt)
            return { runId: 'run-notification' }
          },
        },
      }),
    )

    const response = await gateway.handleTextMessage(
      'client-1',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session.prompt',
        params: { sessionId: 'session-1', prompt: 'hello' },
      }),
    )

    expect(response).toBeUndefined()
    expect(prompted).toEqual(['hello'])
  })

  test('preserves session.prompt payload through params parsing', async () => {
    const payload = {
      message: 'hello with media ref',
      attachments: [
        {
          content: 'base64-image',
          mimeType: 'image/png',
          fileName: 'image.png',
        },
      ],
    }
    const promptedParams: unknown[] = []
    const gateway = new ProtocolGateway(
      createTestPorts({
        session: {
          prompt: params => {
            promptedParams.push(params)
            return { runId: 'run-with-payload' }
          },
        },
      }),
    )

    const response = parseResponse(
      await gateway.handleTextMessage(
        'client-1',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'prompt-1',
          method: 'session.prompt',
          params: { sessionId: 'session-1', prompt: 'hello', payload },
        }),
      ),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'prompt-1',
      result: { runId: 'run-with-payload' },
    })
    expect(promptedParams).toEqual([
      { sessionId: 'session-1', prompt: 'hello', payload },
    ])
  })

  test('replays events before reporting an event subscription', async () => {
    const gateway = new ProtocolGateway(createTestPorts())

    const response = parseResponse(
      await gateway.handleTextMessage(
        'client-1',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'sub-1',
          method: 'events.subscribe',
          params: { sessionId: 'session-1', afterSeq: 7 },
        }),
      ),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'sub-1',
      result: {
        resultType: 'subscribed',
        clientId: 'client-1',
        sessionId: 'session-1',
        afterSeq: 7,
        replayed: [{ eventId: 'session-1-7' }],
      },
    })
  })
})
