import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';
import type { RuntimeSessionTransport } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import {
  createMatchaAgentRuntimeAdapterRegistrationFactory,
  MatchaAgentAppServerClient,
  MatchaAgentProtocolAdapter,
} from '../../runtime-host/application/adapters/matcha-agent/runtime';
import {
  createEmptyCanonicalSessionState,
  reduceCanonicalSessionEvent,
} from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { buildRenderItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import type { MatchaAgentAppServerEventListener } from '../../runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-app-server-client';
import {
  readMatchaTerminalDeliveryTraceContext,
  type MatchaTerminalDeliveryTrace,
} from '../../runtime-host/shared/matcha-terminal-delivery-trace';
import {
  MATCHA_AGENT_RUNTIME_ADAPTER_ID,
  MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
} from '../../runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity';

type RecordedAppServerRequest = {
  method: string;
  params: unknown;
};

type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

class RecordingMatchaAgentAppServerClient extends MatchaAgentAppServerClient {
  readonly requests: RecordedAppServerRequest[] = [];
  private readonly eventListeners = new Set<MatchaAgentAppServerEventListener>();

  constructor(private readonly handleRequest: RequestHandler = () => ({})) {
    super({ url: 'http://127.0.0.1:3212' });
  }

  override async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return await this.handleRequest(method, params);
  }

  override onEvent(listener: MatchaAgentAppServerEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  emitEvent(eventEnvelope: unknown): void {
    for (const listener of this.eventListeners) {
      listener(eventEnvelope);
    }
  }
}

function enabledAppServerEnv(): Record<string, string> {
  return {
    MATCHACLAW_MATCHA_AGENT_APP_SERVER_ENABLED: '1',
    MATCHACLAW_MATCHA_AGENT_APP_SERVER_URL: 'http://127.0.0.1:3212',
    MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN: 'internal-token',
  };
}

function createMatchaTransport(
  client: MatchaAgentAppServerClient,
  terminalDeliveryTrace?: MatchaTerminalDeliveryTrace,
): RuntimeSessionTransport {
  const [adapter] = createMatchaAgentRuntimeAdapterRegistrationFactory({
    env: enabledAppServerEnv(),
    createClient: () => client,
    terminalDeliveryTrace,
  }).create();
  const endpoint = adapter.endpoints[0];
  if (!endpoint) throw new Error('expected matcha-agent endpoint');
  return adapter.createTransport(endpoint, { gateway: {} as never });
}

function assertMatchaTransportHasSessionLifecycle(
  transport: RuntimeSessionTransport,
): asserts transport is RuntimeSessionTransport & Required<Pick<RuntimeSessionTransport, 'ensureSession' | 'startSessionEvents' | 'stopSessionEvents'>> {
  if (!transport.ensureSession || !transport.startSessionEvents || !transport.stopSessionEvents) {
    throw new Error('expected matcha-agent transport to expose session lifecycle hooks');
  }
}

function matchaContext(endpointSessionId = 'endpoint-session-1') {
  return createRuntimeSessionContext({
    identity: {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
      },
      agentId: 'matcha',
      sessionKey: `matcha-agent:session:${endpointSessionId}`,
    },
    protocolId: MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
    endpointSessionId,
  });
}

describe('matcha-agent runtime adapter registration', () => {
  it('is disabled without Electron-provided app-server endpoint env', () => {
    const registry = new AgentRuntimeRegistry();
    const [adapter] = createMatchaAgentRuntimeAdapterRegistrationFactory({
      env: {},
    }).create();

    registry.registerRuntimeAdapter(adapter);

    expect(registry.listRuntimeAdapters()).toHaveLength(1);
    expect(registry.listEndpoints()).toEqual([]);
    expect(registry.listCapabilities()).toEqual([]);
  });

  it('registers native endpoint and runtime capabilities from app-server endpoint env', () => {
    const registry = new AgentRuntimeRegistry();
    const [adapter] = createMatchaAgentRuntimeAdapterRegistrationFactory({
      env: enabledAppServerEnv(),
    }).create();

    registry.registerRuntimeAdapter(adapter);

    expect(registry.listEndpoints()).toEqual([
      expect.objectContaining({
        id: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
        runtimeAdapterId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
        displayName: 'Matcha Agent',
      }),
    ]);
    expect(registry.listCapabilities().map((capability) => capability.id)).toContain('agent.run');
  });
});

function appServerEnvelope(event: Record<string, unknown> & { type: string }, seq = 1) {
  return {
    eventId: `event-${seq}`,
    sessionId: 'endpoint-session-protocol',
    seq,
    createdAt: `2026-07-06T00:00:0${seq}.000Z`,
    runId: 'run-1',
    event,
  };
}

function reduceEventsForProtocol(events: ReturnType<MatchaAgentProtocolAdapter['eventAdapter']['translate']>) {
  const context = matchaContext('endpoint-session-protocol');
  const state = createEmptyCanonicalSessionState('endpoint-session-protocol', context);
  for (const event of events) {
    reduceCanonicalSessionEvent(state, event);
  }
  return state;
}

describe('matcha-agent protocol adapter', () => {
  it('projects Claude Code SDK assistant text deltas from sdk.message into canonical message parts', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const events = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' Hello from delta\n' },
        },
      },
      projectionHints: { messageId: 'assistant-message-1' },
    }), context);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'message_part',
        mode: 'snapshot',
        role: 'assistant',
        kind: 'text',
        messageId: 'assistant-message-1',
        originMessageId: 'assistant-message-1',
        partId: 'assistant-message-1:text',
        text: ' Hello from delta\n',
        content: ' Hello from delta\n',
        status: 'streaming',
      }),
    ]);
  });

  it('replays async JSONL transcript lines into canonical user and assistant events', async () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');
    async function* lines(): AsyncIterable<string> {
      yield JSON.stringify({
        timestamp: 1,
        message: {
          role: 'user',
          id: 'user-message-async-replay',
          content: 'Async replay question',
        },
      });
      yield JSON.stringify({
        timestamp: 2,
        message: {
          role: 'assistant',
          id: 'assistant-message-async-replay',
          content: [{ type: 'text', text: 'Async replay text' }],
        },
      });
    }

    const events: ReturnType<MatchaAgentProtocolAdapter['eventAdapter']['translate']> = [];
    for await (const event of adapter.replayAdapter.replayTranscript(context.sessionKey, lines(), context)) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        role: 'user',
        kind: 'text',
        messageId: 'user-message-async-replay',
        text: 'Async replay question',
        status: 'final',
      }),
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        role: 'assistant',
        kind: 'text',
        messageId: 'assistant-message-async-replay',
        text: 'Async replay text',
        status: 'final',
      }),
    ]));
  });

  it('keeps a parent-linked app-server session transcript tool sequence in one historical assistant turn', async () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-history-replay');
    const transcript = [
      {
        id: 'user-prompt',
        timestamp: '2026-07-10T00:00:00.000Z',
        message: {
          role: 'user',
          id: 'user-prompt',
          content: 'Inspect the session history.',
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
      {
        id: 'assistant-read',
        parentId: 'user-prompt',
        timestamp: '2026-07-10T00:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-read',
          originMessageId: 'user-prompt',
          content: [{ type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: 'package.json' } }],
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
      {
        id: 'tool-read-result',
        parentId: 'assistant-read',
        timestamp: '2026-07-10T00:00:02.000Z',
        message: {
          role: 'toolresult',
          id: 'tool-read-result',
          originMessageId: 'assistant-read',
          toolCallId: 'tool-read',
          content: [{ type: 'tool_result', tool_use_id: 'tool-read', content: 'package content' }],
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
      {
        id: 'assistant-grep',
        parentId: 'tool-read-result',
        timestamp: '2026-07-10T00:00:03.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-grep',
          originMessageId: 'tool-read-result',
          content: [{ type: 'tool_use', id: 'tool-grep', name: 'Grep', input: { pattern: 'scripts' } }],
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
      {
        id: 'tool-grep-result',
        parentId: 'assistant-grep',
        timestamp: '2026-07-10T00:00:04.000Z',
        message: {
          role: 'toolresult',
          id: 'tool-grep-result',
          originMessageId: 'assistant-grep',
          toolCallId: 'tool-grep',
          content: [{ type: 'tool_result', tool_use_id: 'tool-grep', content: 'scripts found' }],
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
      {
        id: 'assistant-final',
        parentId: 'tool-grep-result',
        timestamp: '2026-07-10T00:00:05.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-final',
          originMessageId: 'tool-grep-result',
          content: [{ type: 'text', text: 'The session history is ready.' }],
          metadata: { sessionId: 'endpoint-session-history-replay' },
        },
      },
    ];

    const state = createEmptyCanonicalSessionState(context.sessionKey, context);
    for await (const event of adapter.replayAdapter.replayTranscript(
      context.sessionKey,
      transcript.map((line) => JSON.stringify(line)),
      context,
    )) {
      reduceCanonicalSessionEvent(state, event);
    }

    const assistantTurns = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] })
      .filter((item) => item.kind === 'assistant-turn');

    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      tools: [
        { toolCallId: 'tool-read', status: 'completed' },
        { toolCallId: 'tool-grep', status: 'completed' },
      ],
      text: 'The session history is ready.',
    });
  });

  it('projects native app-server tool.started/tool.completed into canonical tool state with owner bindings', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const events = [
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'tool.started',
        toolCallId: 'tool-native-1',
        toolName: 'Read',
        input: { file_path: 'package.json' },
      }, 1), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'tool.completed',
        toolCallId: 'tool-native-1',
        result: 'package contents',
      }, 2), context),
    ];

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        phase: 'started',
        toolCallId: 'tool-native-1',
        name: 'Read',
        input: { file_path: 'package.json' },
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'run:member:matcha:run-1:tools',
      }),
      expect.objectContaining({
        type: 'tool',
        phase: 'completed',
        toolCallId: 'tool-native-1',
        output: 'package contents',
        outputText: 'package contents',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'run:member:matcha:run-1:tools',
      }),
    ]));

    const state = reduceEventsForProtocol(events);
    expect(state.tools).toEqual([
      expect.objectContaining({
        toolCallId: 'tool-native-1',
        name: 'Read',
        input: { file_path: 'package.json' },
        output: 'package contents',
        outputText: 'package contents',
        status: 'completed',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'run:member:matcha:run-1:tools',
      }),
    ]);
  });

  it('projects SDK assistant final tool_use blocks while preserving final text message parts', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const toolOnlyEvents = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'assistant',
        uuid: 'assistant-message-tool-only',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu-final-only', name: 'TodoWrite', input: { todos: [] } }],
        },
      },
      projectionHints: { messageId: 'assistant-message-tool-only' },
    }, 1), context);
    const toolAndTextEvents = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'assistant',
        uuid: 'assistant-message-tool-and-text',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will read the package file.' },
            { type: 'tool_use', id: 'toolu-final-with-text', name: 'Read', input: { file_path: 'package.json' } },
          ],
        },
      },
      projectionHints: { messageId: 'assistant-message-tool-and-text' },
    }, 2), context);

    expect(toolOnlyEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        phase: 'started',
        toolCallId: 'toolu-final-only',
        name: 'TodoWrite',
        input: { todos: [] },
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-message-tool-only',
      }),
    ]));
    expect(toolAndTextEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        messageId: 'assistant-message-tool-and-text',
        text: 'I will read the package file.',
        status: 'final',
      }),
      expect.objectContaining({
        type: 'tool',
        phase: 'started',
        toolCallId: 'toolu-final-with-text',
        name: 'Read',
        input: { file_path: 'package.json' },
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-message-tool-and-text',
      }),
    ]));

    const state = reduceEventsForProtocol([...toolOnlyEvents, ...toolAndTextEvents]);
    expect(state.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: 'toolu-final-only',
        name: 'TodoWrite',
        input: { todos: [] },
        status: 'running',
      }),
      expect.objectContaining({
        toolCallId: 'toolu-final-with-text',
        name: 'Read',
        input: { file_path: 'package.json' },
        status: 'running',
      }),
    ]));
    expect(state.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: 'assistant-message-tool-and-text',
        text: 'I will read the package file.',
        status: 'final',
      }),
    ]));
  });

  it('projects SDK streaming tool_use start and input_json_delta into canonical tool updates', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const events = [
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu-stream-1', name: 'Read', input: {} },
          },
        },
        projectionHints: { messageId: 'assistant-message-stream-tool' },
      }, 1), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"package.json"}' },
          },
        },
        projectionHints: { messageId: 'assistant-message-stream-tool' },
      }, 2), context),
    ];

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        phase: 'started',
        toolCallId: 'toolu-stream-1',
        name: 'Read',
        input: {},
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-message-stream-tool',
      }),
      expect.objectContaining({
        type: 'tool',
        phase: 'updated',
        toolCallId: 'toolu-stream-1',
        inputDelta: '{"file_path":"package.json"}',
        input: { file_path: 'package.json' },
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-message-stream-tool',
      }),
    ]));

    const state = reduceEventsForProtocol(events);
    expect(state.tools).toEqual([
      expect.objectContaining({
        toolCallId: 'toolu-stream-1',
        name: 'Read',
        input: { file_path: 'package.json' },
        status: 'running',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-message-stream-tool',
      }),
    ]);
  });

  it('projects SDK user tool_result content into canonical completed and failed tools', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const events = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'user',
        uuid: 'user-message-tool-results',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-result-ok', content: 'Read ok' },
            { type: 'tool_result', tool_use_id: 'toolu-result-error', content: 'Read failed', is_error: true },
          ],
        },
      },
      projectionHints: { messageId: 'user-message-tool-results' },
    }, 1), context);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        phase: 'completed',
        toolCallId: 'toolu-result-ok',
        output: 'Read ok',
        outputText: 'Read ok',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'run:member:matcha:run-1:tools',
      }),
      expect.objectContaining({
        type: 'tool',
        phase: 'failed',
        toolCallId: 'toolu-result-error',
        output: 'Read failed',
        outputText: 'Read failed',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'run:member:matcha:run-1:tools',
      }),
    ]));

    const state = reduceEventsForProtocol(events);
    expect(state.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: 'toolu-result-ok',
        output: 'Read ok',
        outputText: 'Read ok',
        status: 'completed',
      }),
      expect.objectContaining({
        toolCallId: 'toolu-result-error',
        output: 'Read failed',
        outputText: 'Read failed',
        status: 'error',
      }),
    ]));
  });

  it('keeps observed SDK tool results, approvals, and cancel lifecycle in one coherent canonical run state', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');
    const state = createEmptyCanonicalSessionState('endpoint-session-protocol', context);
    const envelopes = [
      appServerEnvelope({ type: 'run.started', runId: 'run-1', workerId: 'worker-1' }, 1),
      appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call-read-1', name: 'Read', input: {} },
          },
        },
        projectionHints: { messageId: 'assistant-read' },
      }, 2),
      appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'assistant',
          uuid: 'assistant-read',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-read-1', name: 'Read', input: { file_path: 'blocked.ts' } }],
          },
        },
        projectionHints: { messageId: 'assistant-read' },
      }, 3),
      appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'user',
          uuid: 'user-read-result',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-read-1', content: 'Read failed', is_error: true }],
          },
        },
        projectionHints: { messageId: 'user-read-result' },
      }, 4),
      appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call-write-1', name: 'Write', input: {} },
          },
        },
        projectionHints: { messageId: 'assistant-write' },
      }, 5),
      appServerEnvelope({
        type: 'approval.requested',
        approval: {
          approvalId: 'approval-write-1',
          sessionId: 'endpoint-session-protocol',
          runId: 'run-1',
          workerId: 'worker-1',
          toolCallId: 'call-write-1',
          toolName: 'Write',
          prompt: 'Write blocked.ts',
          options: [{ optionId: 'reject_once', label: 'Deny', kind: 'reject_once' }],
          status: { type: 'pending', requestedAt: '2026-07-06T00:00:06.000Z' },
        },
      }, 6),
      appServerEnvelope({
        type: 'approval.resolved',
        approval: {
          approvalId: 'approval-write-1',
          sessionId: 'endpoint-session-protocol',
          runId: 'run-1',
          workerId: 'worker-1',
          toolCallId: 'call-write-1',
          toolName: 'Write',
          prompt: 'Write blocked.ts',
          options: [{ optionId: 'reject_once', label: 'Deny', kind: 'reject_once' }],
          status: { type: 'cancelled', resolvedAt: '2026-07-06T00:00:07.000Z', reason: 'runCancelled' },
        },
      }, 7),
      appServerEnvelope({ type: 'run.cancelled', runId: 'run-1', reason: 'user stopped' }, 8),
    ];

    const events = envelopes.flatMap((envelope) => adapter.eventAdapter.translate(envelope, context));
    for (const event of events) {
      reduceCanonicalSessionEvent(state, event);
    }

    expect(state.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: 'call-read-1',
        name: 'Read',
        input: { file_path: 'blocked.ts' },
        output: 'Read failed',
        outputText: 'Read failed',
        status: 'error',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-read',
      }),
      expect.objectContaining({
        toolCallId: 'call-write-1',
        name: 'Write',
        status: 'error',
        ownerTurnKey: 'run:member:matcha:run-1',
        ownerMessageKey: 'message:assistant:member:matcha:assistant-write',
      }),
    ]));
    expect(state.approvals).toEqual([]);
    expect(state.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'aborted',
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
    });

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    const assistantTurn = items.find((item) => item.kind === 'assistant-turn');
    expect(assistantTurn).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'run:member:matcha:run-1',
      tools: [
        { toolCallId: 'call-read-1', status: 'error' },
        { toolCallId: 'call-write-1', status: 'error' },
      ],
    });
  });

  it('accumulates Claude Code SDK assistant text deltas and preserves boundary whitespace in canonical state', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');
    const state = createEmptyCanonicalSessionState('endpoint-session-protocol', context);

    const translatedEvents = [
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' leading ' },
          },
        },
        projectionHints: { messageId: 'assistant-message-deltas' },
      }, 1), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'middle\n' },
          },
        },
        projectionHints: { messageId: 'assistant-message-deltas' },
      }, 2), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' trailing  ' },
          },
        },
        projectionHints: { messageId: 'assistant-message-deltas' },
      }, 3), context),
    ];

    expect(translatedEvents).toEqual([
      expect.objectContaining({
        type: 'message_part',
        mode: 'snapshot',
        messageId: 'assistant-message-deltas',
        text: ' leading ',
        content: ' leading ',
        status: 'streaming',
      }),
      expect.objectContaining({
        type: 'message_part',
        mode: 'snapshot',
        messageId: 'assistant-message-deltas',
        text: ' leading middle\n',
        content: ' leading middle\n',
        status: 'streaming',
      }),
      expect.objectContaining({
        type: 'message_part',
        mode: 'snapshot',
        messageId: 'assistant-message-deltas',
        text: ' leading middle\n trailing  ',
        content: ' leading middle\n trailing  ',
        status: 'streaming',
      }),
    ]);

    for (const event of translatedEvents) {
      reduceCanonicalSessionEvent(state, event);
    }

    expect(state.messages).toEqual([
      expect.objectContaining({
        messageId: 'assistant-message-deltas',
        text: ' leading middle\n trailing  ',
        content: ' leading middle\n trailing  ',
        status: 'streaming',
      }),
    ]);
  });

  it('does not project non-text assistant finals or message.completed as empty text that clears streamed text', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');
    const state = createEmptyCanonicalSessionState('endpoint-session-protocol', context);

    const streamedEvents = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'streamed text  ' },
        },
      },
      projectionHints: { messageId: 'assistant-message-non-text-final' },
    }, 1), context);
    const nonTextFinalEvents = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'sdk.message',
      sdkMessageVersion: 'claude-code-sdk-message-v1',
      sdkMessage: {
        type: 'assistant',
        uuid: 'assistant-message-non-text-final',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'TodoWrite', input: { todos: [] } }],
        },
      },
      projectionHints: { messageId: 'assistant-message-non-text-final' },
    }, 2), context);
    const completedEvents = adapter.eventAdapter.translate(appServerEnvelope({
      type: 'message.completed',
      messageId: 'assistant-message-non-text-final',
    }, 3), context);
    const translatedEvents = [
      ...streamedEvents,
      ...nonTextFinalEvents,
      ...completedEvents,
    ];

    expect(nonTextFinalEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        messageId: 'assistant-message-non-text-final',
        text: '',
      }),
    ]));
    expect(completedEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        messageId: 'assistant-message-non-text-final',
        text: '',
      }),
    ]));

    for (const event of translatedEvents) {
      reduceCanonicalSessionEvent(state, event);
    }

    expect(state.messages).toEqual([
      expect.objectContaining({
        messageId: 'assistant-message-non-text-final',
        text: 'streamed text  ',
        content: 'streamed text  ',
      }),
    ]);
  });

  it('does not translate SDK message_stop or result into lifecycle events', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');

    const events = [
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          uuid: 'stream-event-stop',
          parent_tool_use_id: null,
          event: { type: 'message_stop' },
        },
        projectionHints: { messageId: 'assistant-message-stop' },
      }, 1), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'result',
          uuid: 'result-message-1',
          subtype: 'success',
          stop_reason: 'end_turn',
        },
        projectionHints: { messageId: 'result-message-1', isTerminal: true },
      }, 2), context),
    ];

    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lifecycle' }),
    ]));
    expect(events).toEqual([]);
  });

  it('projects Claude Code SDK assistant final text and does not let empty message.completed overwrite streamed text', () => {
    const adapter = new MatchaAgentProtocolAdapter();
    const context = matchaContext('endpoint-session-protocol');
    const state = createEmptyCanonicalSessionState('endpoint-session-protocol', context);

    const translatedEvents = [
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'streamed text' },
          },
        },
        projectionHints: { messageId: 'assistant-message-2' },
      }, 1), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage: {
          type: 'assistant',
          uuid: 'assistant-message-2',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'streamed text' }],
          },
        },
        projectionHints: { messageId: 'assistant-message-2' },
      }, 2), context),
      ...adapter.eventAdapter.translate(appServerEnvelope({
        type: 'message.completed',
        messageId: 'assistant-message-2',
      }, 3), context),
    ];

    expect(translatedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        messageId: 'assistant-message-2',
        text: 'streamed text',
        content: [{ type: 'text', text: 'streamed text' }],
        status: 'final',
      }),
    ]));
    expect(translatedEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        mode: 'final',
        messageId: 'assistant-message-2',
        text: '',
        content: '',
      }),
    ]));

    for (const event of translatedEvents) {
      reduceCanonicalSessionEvent(state, event);
    }

    expect(state.messages).toEqual([
      expect.objectContaining({
        messageId: 'assistant-message-2',
        text: 'streamed text',
        content: [{ type: 'text', text: 'streamed text' }],
        status: 'final',
      }),
    ]);
  });
});

describe('matcha-agent runtime transport session lifecycle', () => {
  it('loads an existing endpoint session before creating a new one on repeated ensure calls', async () => {
    const client = new RecordingMatchaAgentAppServerClient((method) => {
      if (method === 'session.load' && client.requests.length === 1) {
        throw new Error('Session not found: endpoint-session-create');
      }
      return {};
    });
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-create');

    await expect(transport.ensureSession({
      context,
      cwd: 'e:/workspace/project',
      title: 'Project chat',
      model: 'claude-opus',
      permissionMode: 'acceptEdits',
    })).resolves.toEqual({ success: true });
    await expect(transport.ensureSession({
      context,
      cwd: 'e:/workspace/project',
    })).resolves.toEqual({ success: true });

    expect(client.requests).toEqual([
      {
        method: 'session.load',
        params: {
          sessionId: 'endpoint-session-create',
        },
      },
      {
        method: 'session.create',
        params: {
          sessionId: 'endpoint-session-create',
          cwd: 'e:/workspace/project',
          title: 'Project chat',
          model: 'claude-opus',
          permissionMode: 'acceptEdits',
        },
      },
      {
        method: 'session.load',
        params: {
          sessionId: 'endpoint-session-create',
        },
      },
    ]);
  });

  it('uses an existing endpoint session when session.load succeeds', async () => {
    const client = new RecordingMatchaAgentAppServerClient();
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-existing');

    await expect(transport.ensureSession({
      context,
      cwd: 'e:/workspace/project',
    })).resolves.toEqual({ success: true });

    expect(client.requests).toEqual([
      {
        method: 'session.load',
        params: {
          sessionId: 'endpoint-session-existing',
        },
      },
    ]);
  });

  it('does not create a blank session when session.load fails for reasons other than not found', async () => {
    const client = new RecordingMatchaAgentAppServerClient((method) => {
      if (method === 'session.load') {
        throw new Error('Transcript parse failed');
      }
      return {};
    });
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-load-error');

    await expect(transport.ensureSession({
      context,
      cwd: 'e:/workspace/project',
    })).resolves.toEqual({
      success: false,
      error: 'Transcript parse failed',
    });

    expect(client.requests).toEqual([
      {
        method: 'session.load',
        params: {
          sessionId: 'endpoint-session-load-error',
        },
      },
    ]);
  });

  it('continues consuming sequenced events after one ingress failure', async () => {
    const client = new RecordingMatchaAgentAppServerClient((method) => (
      method === 'events.subscribe'
        ? { replayed: [] }
        : {}
    ));
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-ingress-failure');
    const consumedEvents: unknown[] = [];

    await transport.startSessionEvents({
      context,
      consume: async (eventEnvelope) => {
        if ((eventEnvelope as { seq: number }).seq === 1) {
          throw new Error('ingress rejected first event');
        }
        consumedEvents.push(eventEnvelope);
      },
    });
    client.emitEvent({ sessionId: 'endpoint-session-ingress-failure', seq: 1, kind: 'rejected' });
    client.emitEvent({ sessionId: 'endpoint-session-ingress-failure', seq: 2, kind: 'accepted' });

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(consumedEvents).toEqual([
      {
        sessionId: 'endpoint-session-ingress-failure',
        sessionKey: context.endpointSessionId,
        seq: 2,
        kind: 'accepted',
      },
    ]);
  });

  it('normalizes app-server event envelopes with the ingress session key without changing sessionId', async () => {
    const client = new RecordingMatchaAgentAppServerClient((method) => (
      method === 'events.subscribe'
        ? { replayed: [] }
        : {}
    ));
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-identity');
    const consumedEvents: unknown[] = [];
    const appServerEventEnvelope = {
      sessionId: 'endpoint-session-identity',
      seq: 1,
      runId: 'run-session-identity',
      event: { type: 'run.started' },
    };

    await transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push(eventEnvelope);
      },
    });
    client.emitEvent(appServerEventEnvelope);

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(consumedEvents).toEqual([
      {
        ...appServerEventEnvelope,
        sessionKey: context.endpointSessionId,
      },
    ]);
    expect((consumedEvents[0] as { sessionId: string }).sessionId).toBe(appServerEventEnvelope.sessionId);
  });

  it('traces an ordered terminal delivery with opaque correlation metadata', async () => {
    const fixtureSessionId = 'fixture-session-terminal-delivery';
    const fixtureRunId = 'fixture-run-terminal-delivery';
    const fixtureEventId = 'fixture-event-terminal-delivery';
    const fixtureAssistantText = 'fixture assistant text must stay outside trace records';
    const fixtureErrorMessage = 'fixture error message must stay outside trace records';
    const traceRecords: Parameters<MatchaTerminalDeliveryTrace>[0][] = [];
    const client = new RecordingMatchaAgentAppServerClient((method) => (
      method === 'events.subscribe' ? { replayed: [] } : {}
    ));
    const transport = createMatchaTransport(client, (record) => traceRecords.push(record));
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext(fixtureSessionId);
    const consumedEvents: unknown[] = [];
    const terminalEnvelope = {
      eventId: fixtureEventId,
      sessionId: fixtureSessionId,
      seq: 1,
      runId: fixtureRunId,
      createdAt: '2026-07-12T00:00:00.000Z',
      event: {
        type: 'run.completed' as const,
        runId: fixtureRunId,
        stopReason: 'end_turn' as const,
        usage: { outputTokens: 1 },
        fixtureAssistantText,
        fixtureErrorMessage,
      },
    };

    await transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push(eventEnvelope);
      },
    });
    client.emitEvent(terminalEnvelope);

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(traceRecords.map((record) => record.stage)).toEqual([
      'bridge_received',
      'bridge_consume_resolved',
      'bridge_checkpoint_advanced',
    ]);
    expect(consumedEvents).toHaveLength(1);
    const traceContext = readMatchaTerminalDeliveryTraceContext(consumedEvents[0]);
    expect(traceContext).toEqual({
      bridgeTraceId: 'matcha-bridge-1',
      runTraceId: 'matcha-run-1',
      eventClass: 'terminal',
      terminalPhase: 'final',
    });
    expect(traceContext?.bridgeTraceId).not.toBe(fixtureSessionId);
    expect(traceContext?.runTraceId).not.toBe(fixtureRunId);
    const traceJson = JSON.stringify(traceRecords);
    for (const forbiddenValue of [
      fixtureSessionId,
      fixtureRunId,
      fixtureEventId,
      fixtureAssistantText,
      fixtureErrorMessage,
    ]) {
      expect(traceJson).not.toContain(forbiddenValue);
    }
  });

  it('traces a terminal sequence gap without delivering the buffered event', async () => {
    const fixtureSessionId = 'fixture-session-terminal-gap';
    const fixtureRunId = 'fixture-run-terminal-gap';
    const fixtureEventId = 'fixture-event-terminal-gap';
    const fixtureAssistantText = 'fixture assistant text must stay outside buffered trace records';
    const fixtureErrorMessage = 'fixture error message must stay outside buffered trace records';
    const traceRecords: Parameters<MatchaTerminalDeliveryTrace>[0][] = [];
    const client = new RecordingMatchaAgentAppServerClient((method) => (
      method === 'events.subscribe' ? { replayed: [] } : {}
    ));
    const transport = createMatchaTransport(client, (record) => traceRecords.push(record));
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext(fixtureSessionId);
    const consumedEvents: unknown[] = [];
    const terminalEnvelope = {
      eventId: fixtureEventId,
      sessionId: fixtureSessionId,
      seq: 2,
      runId: fixtureRunId,
      createdAt: '2026-07-12T00:00:01.000Z',
      event: {
        type: 'run.completed' as const,
        runId: fixtureRunId,
        stopReason: 'end_turn' as const,
        usage: { outputTokens: 1 },
        fixtureAssistantText,
        fixtureErrorMessage,
      },
    };

    await transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push(eventEnvelope);
      },
    });
    client.emitEvent(terminalEnvelope);

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(traceRecords.map((record) => record.stage)).toEqual([
      'bridge_received',
      'bridge_gap_buffered',
    ]);
    expect(consumedEvents).toEqual([]);
    const traceJson = JSON.stringify(traceRecords);
    for (const forbiddenValue of [
      fixtureSessionId,
      fixtureRunId,
      fixtureEventId,
      fixtureAssistantText,
      fixtureErrorMessage,
    ]) {
      expect(traceJson).not.toContain(forbiddenValue);
    }
  });

  it('replays and subscribes session events once, then stops the live subscription', async () => {
    const replayEvent = { sessionId: 'endpoint-session-events', seq: 1, kind: 'replay' };
    const subscribeEvent = { sessionId: 'endpoint-session-events', seq: 2, kind: 'subscribe' };
    const liveEvent = { sessionId: 'endpoint-session-events', seq: 3, kind: 'live' };
    const duplicatedLiveEvent = { sessionId: 'endpoint-session-events', seq: 4, kind: 'duplicated-live' };
    const replayedAfterStopEvent = { sessionId: 'endpoint-session-events', seq: 5, kind: 'replayed-after-stop' };
    const client = new RecordingMatchaAgentAppServerClient((method, params) => {
      if (method === 'events.subscribe') {
        const afterSeq = params && typeof params === 'object' && 'afterSeq' in params && typeof params.afterSeq === 'number'
          ? params.afterSeq
          : 0;
        return {
          replayed: afterSeq >= 4
            ? [replayedAfterStopEvent]
            : [
                replayEvent,
                subscribeEvent,
                duplicatedLiveEvent,
                { sessionId: 'other-session', seq: 99, kind: 'ignored-replay' },
              ],
        };
      }
      return { params };
    });
    const transport = createMatchaTransport(client);
    assertMatchaTransportHasSessionLifecycle(transport);
    const context = matchaContext('endpoint-session-events');
    const consumedEvents: unknown[] = [];

    const startPromise = transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push(eventEnvelope);
      },
    });
    client.emitEvent(duplicatedLiveEvent);
    await startPromise;
    await transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push({ duplicate: eventEnvelope });
      },
    });
    client.emitEvent(liveEvent);
    client.emitEvent({ sessionId: 'other-session', seq: 100, kind: 'ignored-live' });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    transport.stopSessionEvents(context);
    client.emitEvent({ sessionId: 'endpoint-session-events', seq: 4, kind: 'after-stop' });

    expect(consumedEvents).toEqual([
      { ...replayEvent, sessionKey: context.endpointSessionId },
      { ...subscribeEvent, sessionKey: context.endpointSessionId },
      { ...liveEvent, sessionKey: context.endpointSessionId },
      { ...duplicatedLiveEvent, sessionKey: context.endpointSessionId },
    ]);
    expect(client.requests).toEqual([
      {
        method: 'events.subscribe',
        params: { sessionId: 'endpoint-session-events' },
      },
    ]);

    await transport.startSessionEvents({
      context,
      consume: (eventEnvelope) => {
        consumedEvents.push(eventEnvelope);
      },
    });

    expect(client.requests.slice(1)).toEqual([
      {
        method: 'events.subscribe',
        params: { sessionId: 'endpoint-session-events', afterSeq: 4 },
      },
    ]);
    expect(consumedEvents.at(-1)).toEqual({
      ...replayedAfterStopEvent,
      sessionKey: context.endpointSessionId,
    });
  });

  it('lists app-server sessions as safe external catalog metadata', async () => {
    const client = new RecordingMatchaAgentAppServerClient((method) => {
      if (method === 'session.list') {
        return {
          sessions: [
            {
              sessionId: 'matcha-agent:matcha:session-1',
              workspaceRoot: 'e:/workspace/project',
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:05:00.000Z',
              title: 'Persisted chat',
              runtime: 'matcha-agent',
              model: 'claude-opus',
              permissionMode: 'acceptEdits',
              lastSeq: 7,
              lastSnapshotVersion: 7,
              workerState: { state: 'unloaded', reason: 'notStarted' },
              hasConversation: true,
            },
            {
              sessionId: 'matcha-agent:matcha:session-active',
              createdAt: '2026-07-01T00:10:00.000Z',
              updatedAt: '2026-07-01T00:15:00.000Z',
              runtime: 'matcha-agent',
              workerState: { state: 'running', runId: 'run-1', workerId: 'worker-1', startedAt: '2026-07-01T00:14:00.000Z' },
              hasConversation: true,
              prompt: 'must not leak',
              payload: { secret: 'must not leak' },
            },
            {
              sessionId: 'matcha-agent:matcha:session-empty',
              createdAt: '2026-07-01T00:20:00.000Z',
              updatedAt: '2026-07-01T00:20:00.000Z',
              runtime: 'matcha-agent',
              workerState: { state: 'unloaded', reason: 'notStarted' },
              hasConversation: false,
            },
            {
              sessionId: 'matcha-agent:matcha:session-legacy-empty',
              createdAt: '2026-07-01T00:25:00.000Z',
              updatedAt: '2026-07-01T00:25:00.000Z',
              runtime: 'matcha-agent',
              workerState: { state: 'unloaded', reason: 'notStarted' },
            },
          ],
        };
      }
      return {};
    });
    const transport = createMatchaTransport(client);

    await expect(transport.listExternalSessions?.({
      endpoint: matchaContext().endpointRef,
      agentId: 'matcha',
    })).resolves.toEqual({
      sessions: [
        {
          endpointSessionId: 'matcha-agent:matcha:session-1',
          status: 'completed',
          label: 'Persisted chat',
          runtimeModelRef: 'claude-opus',
          updatedAt: Date.parse('2026-07-01T00:05:00.000Z'),
        },
        {
          endpointSessionId: 'matcha-agent:matcha:session-active',
          status: 'active',
          updatedAt: Date.parse('2026-07-01T00:15:00.000Z'),
        },
      ],
    });

    expect(client.requests).toEqual([{ method: 'session.list', params: {} }]);
  });

  it('sends prompt payload to the app-server session prompt request', async () => {
    const client = new RecordingMatchaAgentAppServerClient();
    const transport = createMatchaTransport(client);
    const context = matchaContext('endpoint-session-prompt-payload');
    const payload = {
      displayMessage: 'Rendered prompt',
      deliver: { mode: 'normal' },
      media: [{ filePath: 'e:/workspace/image.png', mimeType: 'image/png', fileName: 'image.png' }],
    };

    await transport.sendPrompt({
      context,
      message: 'Prompt with attachments',
      runId: 'run-prompt-payload',
      payload,
    });

    expect(client.requests).toEqual([
      {
        method: 'session.prompt',
        params: {
          sessionId: 'endpoint-session-prompt-payload',
          prompt: 'Prompt with attachments',
          runId: 'run-prompt-payload',
          payload,
        },
      },
    ]);
  });
});
