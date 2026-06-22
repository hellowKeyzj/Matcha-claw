import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpenClawV4Adapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-v4-canonical-adapter';
import { createOpenClawTestSessionIdentity, createOpenClawTestRuntimeContext, createTestSessionRuntimeService, openClawTestRuntimeIdentity } from './helpers/session-runtime-fixture';
import { buildCanonicalReplayEventsFromTranscriptMessages } from '../../runtime-host/application/sessions/canonical/canonical-transcript-replay';
import { parseTranscriptMessages } from '../../runtime-host/application/sessions/transcript-parser';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { buildRenderItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import type { SessionAssistantTurnSegment, SessionItemUpdateEvent, SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';

function configDir(): string {
  return join(tmpdir(), `matcha-session-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function expectItemEvent(event: unknown): SessionItemUpdateEvent {
  expect(event).toMatchObject({ sessionUpdate: expect.stringMatching(/^session_item/) });
  return event as SessionItemUpdateEvent;
}

function createService(input: Partial<Parameters<typeof createTestSessionRuntimeService>[0]> = {}) {
  return createTestSessionRuntimeService({
    workspace: { getConfigDir: () => configDir() },
    openclawBridge: {
      chatSend: async () => ({ runId: 'run-sent' }),
      gatewayRpc: async () => ({}),
    },
    ...input,
  });
}

async function createServiceWithConnectedAcpEndpoint() {
  const agentRuntimeRegistry = new AgentRuntimeRegistry({
    gateway: () => ({
      chatSend: async () => ({ runId: 'run-sent' }),
      gatewayRpc: async () => ({}),
    }),
  });
  agentRuntimeRegistry.register({
    protocolConnectors: [createTestAcpClientConnector({
      createTransport: () => ({
        sendPrompt: async () => ({ success: true }),
        abortSession: async () => undefined,
        resolveApproval: async () => ({}),
        inspectReadiness: async () => ({ ready: true, phase: 'ready' }),
      }),
    })],
  });
  await agentRuntimeRegistry.connectRuntimeEndpoint({
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId: 'claude-code',
  });
  return createService({ agentRuntimeRegistry });
}

async function consumeOpenClawTestGatewayEvent(service: ReturnType<typeof createService>, payload: Record<string, unknown>, sessionKey = 'agent:main:main') {
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey);
  return await service.consumeEndpointConversationEvent(sessionIdentity.endpoint, {
    ...payload,
    sessionIdentity,
  });
}

function createOpenClawApprovalEndpoint(agentId = 'default'): ReturnType<typeof createOpenClawTestSessionIdentity>['endpoint'] {
  return createOpenClawTestSessionIdentity(`agent:${agentId}:main`, agentId).endpoint;
}

function createOpenClawApprovalSessionIdentity(sessionKey = 'agent:main:main', agentId = 'main'): ReturnType<typeof createOpenClawTestSessionIdentity> {
  return createOpenClawTestSessionIdentity(sessionKey, agentId);
}

function createClaudeCodeSessionIdentity(sessionKey = 'claude-code:session:1') {
  return {
    endpoint: {
      kind: 'protocol-connector' as const,
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    },
    agentId: 'default',
    sessionKey,
  };
}

describe('session runtime ACP adapter service', () => {
  it('rejects session state snapshot requests without explicit sessionKey', async () => {
    const service = createService();

    const response = await service.getSessionStateSnapshot({
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
    });

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'sessionKey is required' },
    });
  });

  it('translates V4 thinking snapshots into a stable assistant turn before assistant text arrives', async () => {
    const service = createService();

    const [thinking] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'thinking.delta',
      event: {
        sessionKey: 'agent:main:main',
        runId: 'run-thinking',
        seq: 1,
        timestamp: 1_700_000_000_000,
        text: '主人，我先检查入口',
        delta: '主人，我先检查入口',
      },
    });

    const thinkingItem = expectItemEvent(thinking);
    expect(thinkingItem.sessionUpdate).toBe('session_item_chunk');
    expect(thinkingItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-thinking',
      thinking: '主人，我先检查入口',
      text: '',
      segments: [{ kind: 'thinking', text: '主人，我先检查入口' }],
    });
  });

  it('keeps V4 streaming and final chat snapshots on the same live owner turn', async () => {
    const service = createService();

    const [delta] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-stream',
        seq: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '主人，我先看看' }],
        },
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-stream',
        seq: 2,
        message: {
          role: 'assistant',
          messageId: 'assistant-final',
          content: [{ type: 'text', text: '主人，我先看看，已经确认完了' }],
        },
      },
    });

    const deltaItem = expectItemEvent(delta);
    const finalItem = expectItemEvent(final);
    expect(deltaItem.sessionUpdate).toBe('session_item_chunk');
    expect(deltaItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-stream',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-stream:member:default:0',
      text: '主人，我先看看',
    });
    expect(finalItem.sessionUpdate).toBe('session_item');
    expect(finalItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-stream',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-stream:member:default:0',
      text: '主人，我先看看，已经确认完了',
    });
    expect(final.snapshot.items).toHaveLength(1);
  });

  it('finalizes V4 streaming chat when the terminal frame has no message payload', async () => {
    const service = createService();

    const [delta] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-stream-terminal-only',
        seq: 1,
        deltaText: '主人，我先看看',
        message: {
          role: 'assistant',
          content: [],
        },
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-stream-terminal-only',
        seq: 2,
      },
    });

    const deltaItem = expectItemEvent(delta);
    const finalItem = expectItemEvent(final);
    expect(deltaItem.sessionUpdate).toBe('session_item_chunk');
    expect(deltaItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-stream-terminal-only',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-stream-terminal-only:member:default:0',
      text: '主人，我先看看',
      status: 'streaming',
    });
    expect(finalItem.sessionUpdate).toBe('session_item');
    expect(finalItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-stream-terminal-only',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-stream-terminal-only:member:default:0',
      text: '主人，我先看看',
      status: 'final',
    });
    expect(final.snapshot.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'done',
      pendingTurnKey: null,
    });
  });

  it('settles a V4 tool-call turn when lifecycle completion has no sessionKey', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-lifecycle-context-session',
        seq: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool-context-1', name: 'Read', input: { file_path: 'package.json' } }],
        },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-lifecycle-context-session',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-context-1',
        name: 'Read',
        result: 'package content',
      },
    });
    const [completed] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'run.phase',
      phase: 'completed',
      runId: 'run-lifecycle-context-session',
    });

    expect(completed).toMatchObject({
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:main:main',
      runId: 'run-lifecycle-context-session',
      phase: 'final',
    });
    expect(completed.snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'assistant-turn',
      runId: 'run-lifecycle-context-session',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-lifecycle-context-session:member:default:0',
      status: 'final',
    }));
    expect(completed.snapshot.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'done',
      pendingTurnKey: null,
    });
  });

  it('does not duplicate V4 patch deltas when content carries the full snapshot', async () => {
    const service = createService();

    const [first] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-duplicate-streaming',
        seq: 1,
        deltaText: 'Planning',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Planning' }],
        },
      },
    });
    const [second] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-duplicate-streaming',
        seq: 2,
        deltaText: ' workflow',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Planning workflow' }],
        },
      },
    });

    expect(expectItemEvent(first).item).toMatchObject({
      kind: 'assistant-turn',
      text: 'Planning',
      segments: [{ kind: 'message', text: 'Planning' }],
    });
    expect(expectItemEvent(second).item).toMatchObject({
      kind: 'assistant-turn',
      text: 'Planning workflow',
      segments: [{ kind: 'message', text: 'Planning workflow' }],
    });
    const assistantTurns = second.snapshot.items.filter((item: { kind?: string }) => item.kind === 'assistant-turn');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-duplicate-streaming:member:default:0',
      text: 'Planning workflow',
    });
    expect(second.snapshot.runtime).toMatchObject({
      pendingTurnKey: 'openclaw-v4:turn:agent:main:main:run-duplicate-streaming:member:default:0',
    });
  });

  it('keeps post-tool V4 assistant text on the same ordered owner turn without replaying prior text', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-next-turn',
        seq: 1,
        timestamp: 1_700_000_000_000,
        deltaText: 'Considering presentation',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Considering presentation' }],
        },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-next-turn',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-next-turn-1',
        name: 'Read',
        args: { file_path: 'package.json' },
      },
    });
    const [nextAssistant] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-next-turn',
        seq: 3,
        timestamp: 1_700_000_000_020,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Considering presentationI need to answer concisely.' }],
        },
      },
    });

    const assistantTurns = nextAssistant.snapshot.items.filter((item: { kind?: string }) => item.kind === 'assistant-turn');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'openclaw-v4:turn:agent:main:main:run-tool-next-turn:member:default:0',
      text: 'Considering presentation\nI need to answer concisely.',
      tools: [{ toolCallId: 'tool-next-turn-1', name: 'Read', status: 'running' }],
      segments: [
        { kind: 'message', text: 'Considering presentation' },
        { kind: 'tool', tool: { toolCallId: 'tool-next-turn-1', name: 'Read', status: 'running' } },
        { kind: 'message', text: 'I need to answer concisely.' },
      ],
    });
    expect(expectItemEvent(nextAssistant).item).toMatchObject({
      kind: 'assistant-turn',
      text: 'Considering presentation\nI need to answer concisely.',
      segments: [
        { kind: 'message', text: 'Considering presentation' },
        { kind: 'tool', tool: { toolCallId: 'tool-next-turn-1', name: 'Read', status: 'running' } },
        { kind: 'message', text: 'I need to answer concisely.' },
      ],
    });
  });

  it('keeps raw V4 assistant tool result and final snapshot in one ordered session turn', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-order',
        seq: 1,
        timestamp: 1_700_000_000_000,
        deltaText: 'Inspecting',
        message: { role: 'assistant', content: [] },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-order',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-v4-order-1',
        name: 'Read',
        args: { file_path: 'package.json' },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-order',
        seq: 3,
        timestamp: 1_700_000_000_020,
        toolCallId: 'tool-v4-order-1',
        name: 'Read',
        result: 'package content',
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-order',
        seq: 4,
        timestamp: 1_700_000_000_030,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'InspectingDone.' }],
        },
      },
    });

    const assistantTurns = final.snapshot.items.filter((item: { kind?: string }) => item.kind === 'assistant-turn');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      text: 'Inspecting\nDone.',
      tools: [{ toolCallId: 'tool-v4-order-1', name: 'Read', status: 'completed', output: 'package content' }],
      segments: [
        { kind: 'message', text: 'Inspecting' },
        { kind: 'tool', tool: { toolCallId: 'tool-v4-order-1', name: 'Read', status: 'completed', output: 'package content' } },
        { kind: 'message', text: 'Done.' },
      ],
    });
  });

  it('keeps cumulative V4 delta snapshots with tool result and final snapshot deduplicated', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-cumulative-tool',
        seq: 1,
        timestamp: 1_700_000_000_000,
        deltaText: 'Hello',
        message: { role: 'assistant', content: [] },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-cumulative-tool',
        seq: 2,
        timestamp: 1_700_000_000_010,
        deltaText: 'Hello world',
        message: { role: 'assistant', content: [] },
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-cumulative-tool',
        seq: 3,
        timestamp: 1_700_000_000_020,
        toolCallId: 'tool-cumulative-1',
        name: 'Read',
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-cumulative-tool',
        seq: 4,
        timestamp: 1_700_000_000_030,
        toolCallId: 'tool-cumulative-1',
        name: 'Read',
        result: 'ok',
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-cumulative-tool',
        seq: 5,
        timestamp: 1_700_000_000_040,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello worldDone' }],
        },
      },
    });

    const assistantTurn = final.snapshot.items.find((item: { kind?: string }) => item.kind === 'assistant-turn');
    expect(assistantTurn).toMatchObject({
      kind: 'assistant-turn',
      text: 'Hello world\nDone',
      segments: [
        { kind: 'message', text: 'Hello world' },
        { kind: 'tool', tool: { toolCallId: 'tool-cumulative-1', status: 'completed', output: 'ok' } },
        { kind: 'message', text: 'Done' },
      ],
    });
    expect((assistantTurn as { text?: string } | undefined)?.text).not.toContain('HelloHello');
  });

  it('projects equivalent live and historical V4 assistant-tool turns with the same render structure', async () => {
    const liveService = createService();
    const historyService = createService();

    await consumeOpenClawTestGatewayEvent(liveService, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 1,
        timestamp: 1_700_000_000_000,
        deltaText: 'Inspecting',
        message: { role: 'assistant', content: [] },
      },
    });
    await consumeOpenClawTestGatewayEvent(liveService, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-v4-parity-1',
        name: 'Read',
      },
    });
    await consumeOpenClawTestGatewayEvent(liveService, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 3,
        timestamp: 1_700_000_000_020,
        toolCallId: 'tool-v4-parity-1',
        name: 'Read',
        result: 'package content',
      },
    });
    const [liveFinal] = await consumeOpenClawTestGatewayEvent(liveService, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 4,
        timestamp: 1_700_000_000_030,
        message: { role: 'assistant', content: [{ type: 'text', text: 'InspectingDone.' }] },
      },
    });

    await consumeOpenClawTestGatewayEvent(historyService, {
      type: 'session.message',
      event: {
        sessionKey: 'agent:main:main',
        seq: 1,
        message: {
          role: 'assistant',
          id: 'history-assistant-1',
          agentId: 'default',
          metadata: { runId: 'run-v4-parity' },
          content: [{ type: 'text', text: 'Inspecting' }],
        },
      },
    });
    await consumeOpenClawTestGatewayEvent(historyService, {
      type: 'session.tool',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-v4-parity-1',
        name: 'Read',
        agentId: 'default',
      },
    });
    await consumeOpenClawTestGatewayEvent(historyService, {
      type: 'session.tool',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-v4-parity',
        seq: 3,
        timestamp: 1_700_000_000_020,
        toolCallId: 'tool-v4-parity-1',
        name: 'Read',
        result: 'package content',
        agentId: 'default',
      },
    });
    const [historyFinal] = await consumeOpenClawTestGatewayEvent(historyService, {
      type: 'session.message',
      event: {
        sessionKey: 'agent:main:main',
        seq: 4,
        message: {
          role: 'assistant',
          id: 'history-assistant-2',
          agentId: 'default',
          metadata: { runId: 'run-v4-parity' },
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    });

    const summarizeAssistantTurns = (items: readonly SessionRenderItem[]) => items
      .filter((item) => item.kind === 'assistant-turn')
      .map((item) => ({
        text: item.text,
        segments: item.segments.map((segment: SessionAssistantTurnSegment) => segment.kind === 'tool'
          ? {
              kind: 'tool',
              toolCallId: segment.tool.toolCallId,
              name: segment.tool.name,
              status: segment.tool.status,
              output: segment.tool.output,
            }
          : { kind: 'message', text: 'text' in segment ? segment.text : undefined }),
      }));

    expect(summarizeAssistantTurns(historyFinal.snapshot.items)).toEqual(summarizeAssistantTurns(liveFinal.snapshot.items));
  });

  it('replaces the current V4 assistant text when a streaming patch is marked replace', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-replace-streaming',
        seq: 1,
        deltaText: 'Hello world',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      },
    });
    const [replace] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-replace-streaming',
        seq: 2,
        deltaText: 'Hello',
        replace: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
    });

    expect(expectItemEvent(replace).item).toMatchObject({
      kind: 'assistant-turn',
      text: 'Hello',
      segments: [{ kind: 'message', text: 'Hello' }],
    });
    expect(replace.snapshot.items.filter((item: { kind?: string }) => item.kind === 'assistant-turn')).toHaveLength(1);
  });

  it('preserves buffered V4 assistant text when a later final snapshot regresses content', async () => {
    const service = createService();

    const [delta] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-short-final',
        seq: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '已写入。' }] },
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-short-final',
        seq: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: '已' }] },
      },
    });

    expect(expectItemEvent(delta).item).toMatchObject({
      kind: 'assistant-turn',
      text: '已写入。',
      segments: [{ kind: 'message', text: '已写入。' }],
    });
    expect(expectItemEvent(final).item).toMatchObject({
      kind: 'assistant-turn',
      text: '已写入。',
      segments: [{ kind: 'message', text: '已写入。' }],
    });
  });

  it('commits multiple V4 chat frames that share the same provider seq', async () => {
    const service = createService();

    const [delta] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-same-seq',
        seq: 7,
        deltaText: '准备',
        message: { role: 'assistant', content: [{ type: 'text', text: '准备' }] },
      },
    });
    const [final] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-same-seq',
        seq: 7,
        message: { role: 'assistant', content: [{ type: 'text', text: '准备完成' }] },
      },
    });

    expect(expectItemEvent(delta).item).toMatchObject({
      kind: 'assistant-turn',
      text: '准备',
    });
    expect(expectItemEvent(final).item).toMatchObject({
      kind: 'assistant-turn',
      text: '准备完成',
    });
  });

  it('projects V4 tool lifecycle as first-class ACP tool events', async () => {
    const service = createService();

    const [start] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-tool',
        seq: 10,
        timestamp: 1_700_000_000_000,
        toolCallId: 'tool-read-1',
        name: 'Read',
        args: { file_path: 'package.json' },
      },
    });
    const [result] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-tool',
        seq: 11,
        timestamp: 1_700_000_000_100,
        toolCallId: 'tool-read-1',
        result: 'package content',
      },
    });

    const startItem = expectItemEvent(start);
    const resultItem = expectItemEvent(result);
    expect(startItem.sessionUpdate).toBe('session_item_chunk');
    expect(startItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-tool',
      turnKey: 'run:member:default:run-tool',
      tools: [{ toolCallId: 'tool-read-1', name: 'Read', status: 'running' }],
    });
    expect(resultItem.item).toMatchObject({
      kind: 'assistant-turn',
      runId: 'run-tool',
      turnKey: 'run:member:default:run-tool',
      tools: [{ toolCallId: 'tool-read-1', name: 'Read', status: 'completed', output: 'package content' }],
    });
  });

  it('groups live same-run tool-only lifecycle rows into one assistant turn', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-only',
        seq: 1,
        timestamp: 1_700_000_000_000,
        toolCallId: 'tool-live-1',
        name: 'TaskList',
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-only',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-live-1',
        name: 'TaskList',
        result: 'No tasks found.',
      },
    });
    await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-only',
        seq: 3,
        timestamp: 1_700_000_000_020,
        toolCallId: 'tool-live-2',
        name: 'sessions_list',
      },
    });
    const [secondResult] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-only',
        seq: 4,
        timestamp: 1_700_000_000_030,
        toolCallId: 'tool-live-2',
        name: 'sessions_list',
        result: '查看 subagent 会话',
      },
    });

    const assistantTurns = secondResult.snapshot.items.filter((item: { kind?: string }) => item.kind === 'assistant-turn');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'run:member:default:run-tool-only',
      tools: [
        expect.objectContaining({ toolCallId: 'tool-live-1', status: 'completed', output: 'No tasks found.' }),
        expect.objectContaining({ toolCallId: 'tool-live-2', status: 'completed', output: '查看 subagent 会话' }),
      ],
    });
  });

  it('updates the existing V4 assistant turn when a live tool starts under the same owner message', async () => {
    const service = createService();

    const [delta] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-inline',
        seq: 1,
        timestamp: 1_700_000_000_000,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我先读文件。' }],
        },
      },
    });
    const [start] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-inline',
        seq: 2,
        timestamp: 1_700_000_000_010,
        toolCallId: 'tool-inline-read-1',
        name: 'Read',
        args: { file_path: 'package.json' },
      },
    });

    const deltaItem = expectItemEvent(delta);
    const startItem = expectItemEvent(start);
    expect(deltaItem.item).toMatchObject({
      kind: 'assistant-turn',
      text: '我先读文件。',
      tools: [],
      segments: [{ kind: 'message', text: '我先读文件。' }],
    });
    expect(startItem.item).toMatchObject({
      kind: 'assistant-turn',
      text: '我先读文件。',
      tools: [{ toolCallId: 'tool-inline-read-1', name: 'Read', status: 'running' }],
      segments: [
        { kind: 'message', text: '我先读文件。' },
        { kind: 'tool', tool: { toolCallId: 'tool-inline-read-1', name: 'Read', status: 'running' } },
      ],
    });
    expect(start.snapshot.items.filter((item: { kind?: string; text?: string }) => item.kind === 'assistant-turn' && item.text === '我先读文件。')).toHaveLength(1);
  });

  it('turns state-only TodoWrite lifecycle frames into plan snapshots without visible tool cards', async () => {
    const adapter = new OpenClawV4Adapter();
    const events = adapter.translate({
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'agent:main:main',
        runId: 'run-plan',
        seq: 1,
        toolCallId: 'todo-1',
        name: 'TodoWrite',
        args: {
          todos: [{ content: '实现 ACP', activeForm: '实现 ACP', status: 'in_progress' }],
        },
      },
    }, createOpenClawTestRuntimeContext());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'plan',
      sessionId: 'agent:main:main',
      runId: 'run-plan',
      taskSnapshot: {
        todos: [{ content: '实现 ACP', status: 'in_progress' }],
      },
    });
  });

  it('strips state-only TodoWrite blocks from visible chat message snapshots', () => {
    const adapter = new OpenClawV4Adapter();
    const events = adapter.translate({
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-plan',
        seq: 2,
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [{ content: '实现 ACP', status: 'completed' }],
            },
          }],
        },
      },
    }, createOpenClawTestRuntimeContext());

    expect(events).toEqual([
      expect.objectContaining({
        type: 'plan',
        taskSnapshot: expect.objectContaining({
          todos: [{ content: '实现 ACP', status: 'completed' }],
        }),
      }),
    ]);
  });

  it('translates OpenClaw session.message as a replay message snapshot', () => {
    const adapter = new OpenClawV4Adapter();

    const events = adapter.translate({
      type: 'session.message',
      event: {
        sessionKey: 'agent:main:main',
        message: {
          role: 'assistant',
          id: 'assistant-history-1',
          content: [{ type: 'text', text: '历史消息' }],
          metadata: { runId: 'run-history' },
        },
      },
    }, createOpenClawTestRuntimeContext());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'openclaw-v4:session-message:agent:main:main:run-history:assistant-history-1',
      type: 'message_part',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      source: 'replay',
      sessionId: 'agent:main:main',
      role: 'assistant',
      text: '历史消息',
      status: 'final',
      origin: {
        runtimeEventType: 'session.message',
      },
    });
  });

  it('translates OpenClaw session.tool as replay tool fact', () => {
    const adapter = new OpenClawV4Adapter();

    const events = adapter.translate({
      type: 'session.tool',
      event: {
        phase: 'result',
        sessionKey: 'agent:main:main',
        runId: 'run-tool-history',
        seq: 8,
        timestamp: 1_700_000_000_001,
        toolCallId: 'tool-2',
        name: 'Read',
        result: '历史工具结果',
        isError: false,
      },
    }, createOpenClawTestRuntimeContext());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'openclaw-v4:tool-result:agent:main:main:run-tool-history:8:tool-2',
      type: 'tool', phase: 'completed',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      source: 'replay',
      sessionId: 'agent:main:main',
      runId: 'run-tool-history',
      toolCallId: 'tool-2',
      name: 'Read',
      output: '历史工具结果',
      origin: {
        runtimeEventType: 'session.tool',
      },
    });
  });

  it('hydrates transcript as explicit ACP replay boundaries and replay message snapshots', () => {
    const replayEvents = buildCanonicalReplayEventsFromTranscriptMessages('agent:main:main', [{
      role: 'user',
      id: 'user-1',
      content: '你好',
      timestamp: 1,
    }, {
      role: 'assistant',
      id: 'assistant-1',
      content: [{ type: 'text', text: '你好，主人' }],
      timestamp: 2,
    }], openClawTestRuntimeIdentity);
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, replayEvents);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    expect(replayEvents[0]).toMatchObject({ type: 'replay_boundary', source: 'replay', phase: 'start' });
    expect(replayEvents.at(-1)).toMatchObject({ type: 'replay_boundary', source: 'replay', phase: 'end' });
    expect(state.hydrated).toBe(true);
    expect(items).toMatchObject([
      { kind: 'user-message', text: '你好' },
      { kind: 'assistant-turn', text: '你好，主人' },
    ]);
  });

  it('binds replayed transcript tool_call and standalone tool_result rows into one tool turn', () => {
    const replayEvents = buildCanonicalReplayEventsFromTranscriptMessages('agent:main:main', [{
      role: 'assistant',
      id: 'assistant-tool-call',
      metadata: { runId: 'run-history' },
      content: [{ type: 'tool_call', toolCallId: 'tool-legacy-1', name: 'Read', input: { file_path: 'package.json' } }],
      timestamp: 1,
    }, {
      role: 'tool_result',
      id: 'tool-row-1',
      metadata: { runId: 'run-history' },
      toolCallId: 'tool-legacy-1',
      name: 'Read',
      content: 'legacy result',
      timestamp: 2,
    }], openClawTestRuntimeIdentity);
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, replayEvents);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    expect(replayEvents).toEqual([
      expect.objectContaining({ type: 'replay_boundary', phase: 'start' }),
      expect.objectContaining({ type: 'message_part', messageId: 'assistant-tool-call' }),
      expect.objectContaining({ type: 'tool', phase: 'started', toolCallId: 'tool-legacy-1' }),
      expect.objectContaining({ type: 'tool', phase: 'completed', toolCallId: 'tool-legacy-1', output: 'legacy result' }),
      expect.objectContaining({ type: 'replay_boundary', phase: 'end' }),
    ]);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'assistant-turn',
      turnKey: 'transcript:agent:main:main:main:run-history',
      tools: [expect.objectContaining({ toolCallId: 'tool-legacy-1', status: 'completed', output: 'legacy result' })],
      segments: [expect.objectContaining({
        kind: 'tool',
        tool: expect.objectContaining({ toolCallId: 'tool-legacy-1', status: 'completed' }),
      })],
    })]));
  });

  it('groups replayed same-run tool_result rows into one historical assistant turn', () => {
    const replayEvents = buildCanonicalReplayEventsFromTranscriptMessages('agent:main:main', [{
      role: 'tool_result',
      id: 'tool-row-1',
      metadata: { runId: 'run-history' },
      toolCallId: 'tool-history-1',
      name: 'TaskList',
      content: 'No tasks found.',
      timestamp: 1,
    }, {
      role: 'tool_result',
      id: 'tool-row-2',
      metadata: { runId: 'run-history' },
      toolCallId: 'tool-history-2',
      name: '会话列表',
      content: '查看 subagent 会话',
      timestamp: 2,
    }, {
      role: 'tool_result',
      id: 'tool-row-3',
      metadata: { runId: 'run-history' },
      toolCallId: 'tool-history-3',
      name: '智能体',
      content: '查看最近 30 分钟的智能体',
      timestamp: 3,
    }], openClawTestRuntimeIdentity);
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, replayEvents);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    const assistantTurns = items.filter((item) => item.kind === 'assistant-turn');

    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'transcript:agent:main:main:main:run-history',
      tools: [
        expect.objectContaining({ toolCallId: 'tool-history-1', status: 'completed', output: 'No tasks found.' }),
        expect.objectContaining({ toolCallId: 'tool-history-2', status: 'completed', output: '查看 subagent 会话' }),
        expect.objectContaining({ toolCallId: 'tool-history-3', status: 'completed', output: '查看最近 30 分钟的智能体' }),
      ],
    });
  });

  it('groups replayed parent-linked tool rows without runId into one historical assistant turn', () => {
    const transcript = [
      {
        id: 'user-row',
        message: { role: 'user', content: '结束Sessions Yield' },
      },
      {
        id: 'assistant-tool-1',
        parentId: 'user-row',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_task_list', name: 'TaskList', input: {} }],
        },
      },
      {
        id: 'tool-result-1',
        parentId: 'assistant-tool-1',
        message: {
          role: 'toolResult',
          toolCallId: 'call_task_list',
          toolName: 'TaskList',
          content: 'No tasks found.',
        },
      },
      {
        id: 'assistant-tool-2',
        parentId: 'tool-result-1',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_sessions_list', name: 'sessions_list', input: {} }],
        },
      },
      {
        id: 'tool-result-2',
        parentId: 'assistant-tool-2',
        message: {
          role: 'toolResult',
          toolCallId: 'call_sessions_list',
          toolName: 'sessions_list',
          content: '查看 subagent 会话',
        },
      },
      {
        id: 'assistant-final',
        parentId: 'tool-result-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The team dispatch did not complete.' }],
        },
      },
    ].map((line) => JSON.stringify(line)).join('\n');
    const messages = parseTranscriptMessages(transcript);
    const replayEvents = buildCanonicalReplayEventsFromTranscriptMessages('agent:main:main', messages, openClawTestRuntimeIdentity);
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, replayEvents);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    const assistantTurns = items.filter((item) => item.kind === 'assistant-turn');

    expect(messages.slice(1).map((message) => message.originMessageId)).toEqual([
      'user-row',
      'assistant-tool-1',
      'tool-result-1',
      'assistant-tool-2',
      'tool-result-2',
    ]);
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'transcript:agent:main:main:main:parent:user-row',
      text: 'The team dispatch did not complete.',
      tools: [
        expect.objectContaining({ toolCallId: 'call_task_list', status: 'completed', output: 'No tasks found.' }),
        expect.objectContaining({ toolCallId: 'call_sessions_list', status: 'completed', output: '查看 subagent 会话' }),
      ],
      segments: [
        expect.objectContaining({ kind: 'tool' }),
        expect.objectContaining({ kind: 'tool' }),
        expect.objectContaining({ kind: 'message', text: 'The team dispatch did not complete.' }),
      ],
    });
  });

  it('rejects session creation without an explicit RuntimeEndpointRef', async () => {
    const service = createService();

    const response = await service.createSession({ sessionKey: 'agent:main:missing-identity' });

    expect(response).toEqual({
      status: 400,
      data: {
        success: false,
        error: 'RuntimeEndpointRef is required',
      },
    });
  });

  it('rejects listSessions without an explicit RuntimeEndpointRef', async () => {
    const service = createService();

    await expect(service.listSessions({})).resolves.toEqual({
      status: 400,
      data: {
        success: false,
        error: 'RuntimeEndpointRef is required',
      },
    });
  });

  it.each([
    ['loadSession', (service: ReturnType<typeof createService>) => service.loadSession({ sessionKey: 'agent:main:main' })],
    ['resumeSession', (service: ReturnType<typeof createService>) => service.resumeSession({ sessionKey: 'agent:main:main' })],
    ['getSessionStateSnapshot', (service: ReturnType<typeof createService>) => service.getSessionStateSnapshot({ sessionKey: 'agent:main:main' })],
    ['getSessionWindow', (service: ReturnType<typeof createService>) => service.getSessionWindow({ sessionKey: 'agent:main:main' })],
    ['abortSession', (service: ReturnType<typeof createService>) => service.abortSession({ sessionKey: 'agent:main:main' })],
    ['listPendingApprovals', (service: ReturnType<typeof createService>) => service.listPendingApprovals({})],
    ['resolveApproval', (service: ReturnType<typeof createService>) => service.resolveApproval({ id: 'approval-1', sessionKey: 'agent:main:main', decision: 'deny' })],
    ['patchSession', (service: ReturnType<typeof createService>) => service.patchSession({ sessionKey: 'agent:main:main', runtimeModelRef: 'anthropic/claude-sonnet-4-6' })],
    ['deleteSession', (service: ReturnType<typeof createService>) => service.deleteSession({ sessionKey: 'agent:main:main' })],
    ['archiveSession', (service: ReturnType<typeof createService>) => service.archiveSession({ sessionKey: 'agent:main:main' })],
    ['unarchiveSession', (service: ReturnType<typeof createService>) => service.unarchiveSession({ sessionKey: 'agent:main:main' })],
    ['updateSessionStatus', (service: ReturnType<typeof createService>) => service.updateSessionStatus({ sessionKey: 'agent:main:main', status: 'archived' })],
    ['renameSession', (service: ReturnType<typeof createService>) => service.renameSession({ sessionKey: 'agent:main:main', label: 'renamed' })],
  ])('rejects %s without an explicit SessionIdentity', async (_name, action) => {
    const service = createService();

    await expect(action(service)).resolves.toEqual({
      status: 400,
      data: {
        success: false,
        error: 'SessionIdentity is required',
      },
    });
  });

  it('rejects prompts without an explicit SessionIdentity', async () => {
    const service = createService();

    const response = await service.promptSession({
      sessionKey: 'agent:main:main',
      message: '缺身份',
      idempotencyKey: 'client-run-missing-identity',
    });

    expect(response).toEqual({
      status: 400,
      data: {
        success: false,
        error: 'SessionIdentity is required',
      },
    });
  });

  it('submits prompts with the local runId as the gateway runId contract', async () => {
    const chatSend = vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.idempotencyKey,
      status: 'started',
    }));
    const service = createService({
      openclawBridge: {
        chatSend,
        gatewayRpc: async () => ({}),
      },
    });

    const response = await service.promptSession({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
      message: '帮我检查项目',
      idempotencyKey: 'client-run-1',
    });
    await vi.waitFor(() => expect(chatSend).toHaveBeenCalledTimes(1));

    const gatewayParams = chatSend.mock.calls[0][0];
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      sessionKey: 'agent:main:main',
      runId: 'client-run-1',
      snapshot: {
        runtime: {
          activeRunId: 'client-run-1',
          runPhase: 'submitted',
          pendingTurnKey: 'client-run-1',
          lastUserMessageAt: 1_700_000_000_000,
        },
      },
    });
    expect(gatewayParams).toMatchObject({
      sessionKey: 'agent:main:main',
      message: '帮我检查项目',
      idempotencyKey: 'client-run-1',
    });
    expect(gatewayParams.sessionId).toBeUndefined();
    expect(await chatSend.mock.results[0].value).toMatchObject({
      runId: 'client-run-1',
    });
    if (!('snapshot' in response.data)) {
      throw new Error('Expected prompt snapshot');
    }
    expect(response.data.snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        text: '帮我检查项目',
        messageId: 'client-run-1',
        runId: 'client-run-1',
      }),
      expect.objectContaining({
        kind: 'assistant-turn',
        turnKey: 'client-run-1',
        pendingState: 'typing',
      }),
    ]));
  });

  it('accepts endpoint events after the session context has been bound by prompt submission', async () => {
    const chatSend = vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.idempotencyKey,
      status: 'started',
    }));
    const service = createService({
      openclawBridge: {
        chatSend,
        gatewayRpc: async () => ({}),
      },
    });
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');

    await service.promptSession({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      message: '你好',
      idempotencyKey: 'client-run-bound',
    });
    await vi.waitFor(() => expect(chatSend).toHaveBeenCalledTimes(1));
    const [message] = await service.consumeEndpointConversationEvent(sessionIdentity.endpoint, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        sessionIdentity,
        runId: 'client-run-bound',
        seq: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '你好，主人' }] },
      },
    });

    expect(message).toMatchObject({
      sessionUpdate: 'session_item',
      sessionKey: 'agent:main:main',
      item: { kind: 'assistant-turn', text: '你好，主人' },
      snapshot: {
        runtime: {
          activeRunId: null,
          runPhase: 'done',
        },
      },
    });
  });

  it('marks the submitted ACP lifecycle as error when gateway send fails', async () => {
    const emitSessionUpdate = vi.fn();
    const service = createService({
      emitSessionUpdate,
      openclawBridge: {
        chatSend: vi.fn(async () => {
          throw new Error('gateway unavailable');
        }),
        gatewayRpc: async () => ({}),
      },
    });

    const response = await service.promptSession({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
      message: '触发失败',
      idempotencyKey: 'client-run-fail',
    });
    await vi.waitFor(() => expect(emitSessionUpdate).toHaveBeenCalledTimes(1));

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      runId: 'client-run-fail',
      snapshot: {
        runtime: {
          activeRunId: 'client-run-fail',
          runPhase: 'submitted',
        },
      },
    });
    expect(emitSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:main:main',
      runId: 'client-run-fail',
      phase: 'error',
      error: 'Error: gateway unavailable',
      snapshot: expect.objectContaining({
        runtime: expect.objectContaining({
          activeRunId: null,
          runPhase: 'error',
          lastError: 'Error: gateway unavailable',
        }),
        items: expect.arrayContaining([expect.objectContaining({
          kind: 'user-message',
          text: '触发失败',
          runId: 'client-run-fail',
        })]),
      }),
    }));
  });

  it('applies lifecycle terminal events through ACP runtime state', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'run.phase',
      sessionKey: 'agent:main:main',
      runId: 'run-life',
      phase: 'started',
    });
    const [done] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'run.phase',
      sessionKey: 'agent:main:main',
      runId: 'run-life',
      phase: 'completed',
    });

    expect(done.sessionUpdate).toBe('session_info_update');
    expect(done.snapshot.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'done',
    });
  });

  it('creates session keys from the runtime endpoint keying namespace', async () => {
    const service = createService();
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:default:main', 'default');

    const response = await service.createSession({
      endpoint: sessionIdentity.endpoint,
      agentId: 'default',
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      success: true,
      sessionKey: expect.stringMatching(/^agent:default:session-1700000000000-/),
      snapshot: {
        catalog: {
          sessionIdentity: expect.objectContaining({
            endpoint: expect.objectContaining({ kind: 'native-runtime' }),
            agentId: 'default',
          }),
        },
      },
    });
    if (!('snapshot' in response.data)) {
      throw new Error('Expected create session snapshot');
    }
    expect(response.data.snapshot.catalog.sessionIdentity?.sessionKey).toBe(response.data.sessionKey);
  });

  it('keeps gateway-level control state out of session ingress while approval notifications still require SessionIdentity context', async () => {
    const service = createService({
      sessionRuntimeStore: {
        load: async () => ({
          version: 3,
          activeSessionKey: 'agent:main:session-legacy-active',
        }),
        save: async () => undefined,
      },
    });
    await service.listSessions({ endpoint: createOpenClawTestSessionIdentity('agent:main:session-legacy-active').endpoint });

    const [pending] = service.consumeEndpointNotification(
      createOpenClawApprovalEndpoint('main'),
      {
        method: 'exec.approval.requested',
        params: {
          id: 'approval-missing-context',
          sessionKey: 'agent:main:session-legacy-active',
          runId: 'run-approval',
        },
      },
    );

    expect(pending).toMatchObject({
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:main:session-legacy-active',
      snapshot: {
        approvals: [expect.objectContaining({ id: 'approval-missing-context' })],
      },
    });
  });

  it('projects usage and artifact canonical events into session snapshot facts', async () => {
    const service = createService();

    await consumeOpenClawTestGatewayEvent(service, {
      type: 'usage',
      event: {
        sessionKey: 'agent:main:main',
        runId: 'run-usage',
        seq: 1,
        timestamp: 1_700_000_000_040,
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    });
    const [artifact] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'artifact',
      event: {
        sessionKey: 'agent:main:main',
        runId: 'run-usage',
        seq: 2,
        timestamp: 1_700_000_000_050,
        artifact: { id: 'artifact-1', kind: 'text', title: '结果' },
      },
    });

    expect(artifact).toMatchObject({
      sessionUpdate: 'session_info_update',
      snapshot: {
        usage: [{ sessionKey: 'agent:main:main', runId: 'run-usage', payload: { inputTokens: 10, outputTokens: 20 } }],
        artifacts: [{ sessionKey: 'agent:main:main', runId: 'run-usage', payload: { id: 'artifact-1', kind: 'text', title: '结果' } }],
      },
    });
  });

  it('filters pending approvals by explicit SessionIdentity', async () => {
    const service = createService();

    await service.createSession({
      sessionKey: 'agent:main:main',
      endpoint: createOpenClawTestSessionIdentity('agent:main:main').endpoint,
      agentId: 'main',
    });
    await service.createSession({
      sessionKey: 'agent:test:main',
      endpoint: createOpenClawTestSessionIdentity('agent:test:main', 'test').endpoint,
      agentId: 'test',
    });
    service.consumeEndpointNotification(createOpenClawApprovalEndpoint('main'), {
      method: 'exec.approval.requested',
      params: {
        id: 'approval-main',
        sessionKey: 'agent:main:main',
        title: 'Main approval',
        createdAtMs: 1_700_000_000_060,
      },
    });
    service.consumeEndpointNotification(createOpenClawApprovalEndpoint('test'), {
      method: 'exec.approval.requested',
      params: {
        id: 'approval-test',
        sessionKey: 'agent:test:main',
        title: 'Test approval',
        createdAtMs: 1_700_000_000_061,
      },
    });

    const response = await service.listPendingApprovals({
      sessionIdentity: createOpenClawApprovalSessionIdentity('agent:test:main', 'test'),
    });

    expect(response.data).toEqual({
      approvals: [expect.objectContaining({ id: 'approval-test', sessionKey: 'agent:test:main' })],
    });
  });

  it('rejects pending approval list requests without SessionIdentity', async () => {
    const service = createService();

    const response = await service.listPendingApprovals({});

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'SessionIdentity is required' },
    });
  });

  it('resolves approvals through canonical approval events after gateway policy decision succeeds', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const service = createService({
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-sent' }),
        gatewayRpc,
      },
    });

    await service.createSession({
      sessionKey: 'agent:main:main',
      endpoint: createOpenClawTestSessionIdentity('agent:main:main').endpoint,
      agentId: 'main',
    });
    const [pending] = service.consumeEndpointNotification(createOpenClawApprovalEndpoint('main'), {
      method: 'exec.approval.requested',
      params: {
        id: 'approval-1',
        sessionKey: 'agent:main:main',
        runId: 'run-approval',
        title: 'Run command',
        command: 'pnpm test',
        allowedDecisions: ['allow-once', 'deny'],
        createdAtMs: 1_700_000_000_060,
      },
    });
    const response = await service.resolveApproval({
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main', 'main'),
      decision: 'allow-once',
    });
    const list = await service.listPendingApprovals({
      sessionIdentity: createOpenClawApprovalSessionIdentity('agent:main:main'),
    });

    expect(pending).toMatchObject({
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:main:main',
      snapshot: {
        approvals: [{ id: 'approval-1', title: 'Run command' }],
      },
    });
    expect(gatewayRpc).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval-1', decision: 'allow-once' });
    expect(response.status).toBe(200);
    expect(list.data).toEqual({ approvals: [] });
  });

  it('routes plugin approvals to plugin.approval.resolve', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const service = createService({
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-sent' }),
        gatewayRpc,
      },
    });

    await service.createSession({
      sessionKey: 'agent:main:main',
      endpoint: createOpenClawTestSessionIdentity('agent:main:main').endpoint,
      agentId: 'main',
    });
    service.consumeEndpointNotification(createOpenClawApprovalEndpoint('main'), {
      method: 'plugin.approval.requested',
      params: {
        data: {
          id: 'plugin:approval-2',
          request: {
            sessionKey: 'agent:main:main',
            runId: 'run-plugin-approval',
            title: 'Plugin action',
            allowedDecisions: ['allow-once', 'deny'],
          },
        },
      },
    });

    const response = await service.resolveApproval({
      id: 'plugin:approval-2',
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main', 'main'),
      decision: 'allow-once',
    });

    expect(gatewayRpc).toHaveBeenCalledWith('plugin.approval.resolve', { id: 'plugin:approval-2', decision: 'allow-once' });
    expect(response.status).toBe(200);
  });

  it('denies plugin and exec approvals through their own resolve methods before aborting the session', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const service = createService({
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-sent' }),
        gatewayRpc,
      },
    });

    await service.createSession({
      sessionKey: 'agent:main:main',
      endpoint: createOpenClawTestSessionIdentity('agent:main:main').endpoint,
      agentId: 'main',
    });

    const response = await service.abortSession({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
      approvalIds: ['plugin:approval-2', 'approval-1'],
    });

    expect(gatewayRpc).toHaveBeenNthCalledWith(1, 'plugin.approval.resolve', { id: 'plugin:approval-2', decision: 'deny' }, 5000);
    expect(gatewayRpc).toHaveBeenNthCalledWith(2, 'exec.approval.resolve', { id: 'approval-1', decision: 'deny' }, 5000);
    expect(gatewayRpc).toHaveBeenNthCalledWith(3, 'chat.abort', { sessionKey: 'agent:main:main' }, 5000);
    expect(response.status).toBe(200);
  });

  it('returns empty events for unsupported provider payloads', async () => {
    const service = createService();
    await expect(consumeOpenClawTestGatewayEvent(service, {
      type: 'legacy.unknown',
      sessionKey: 'agent:main:main',
    })).resolves.toEqual([]);
  });

  it('accepts OpenClaw gateway conversation events through explicit endpoint ingress', async () => {
    const service = createService();

    const [message] = await consumeOpenClawTestGatewayEvent(service, {
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-endpoint-ingress',
        seq: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    });

    expect(message).toMatchObject({
      sessionUpdate: 'session_item',
      sessionKey: 'agent:main:main',
      item: { kind: 'assistant-turn', text: 'hello' },
    });
  });

  it('rejects endpoint ingress with an invalid endpoint ref', async () => {
    const service = createService();

    await expect(service.consumeEndpointConversationEvent({
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'acp',
    } as never, {
      method: 'session/message',
      params: {
        sessionKey: 'claude-code:session:1',
        runId: 'run-1',
        text: 'hello',
      },
    })).rejects.toThrow('Connector runtime endpoint not registered: acp:acp:undefined');
  });

  it('rejects endpoint ingress when agentId cannot be resolved from event metadata', async () => {
    const service = await createServiceWithConnectedAcpEndpoint();
    const sessionIdentity = createClaudeCodeSessionIdentity();

    await expect(service.consumeEndpointConversationEvent(sessionIdentity.endpoint, {
      method: 'session/message',
      params: {
        sessionKey: 'claude-code:session:1',
        runId: 'run-1',
        text: 'hello',
      },
    })).rejects.toThrow('Session event requires agentId metadata');
  });

  it('rejects approval notifications when agentId cannot be resolved from sessionKey metadata', () => {
    const service = createService();

    expect(() => service.consumeEndpointNotification(
      createOpenClawApprovalEndpoint('main'),
      {
        method: 'exec.approval.requested',
        params: {
          id: 'approval-missing-agent',
          sessionKey: 'main',
          runId: 'run-approval',
        },
      },
    )).toThrow('Session approval notification requires agentId metadata');
  });

  it('rejects endpoint ingress when payload SessionIdentity references an unregistered endpoint', async () => {
    const service = await createServiceWithConnectedAcpEndpoint();
    const sessionIdentity = createClaudeCodeSessionIdentity();

    await expect(service.consumeEndpointConversationEvent(sessionIdentity.endpoint, {
      method: 'session/message',
      params: {
        sessionKey: 'claude-code:session:1',
        sessionIdentity: {
          ...sessionIdentity,
          endpoint: {
            ...sessionIdentity.endpoint,
            endpointId: 'hermes',
          },
        },
        runId: 'run-1',
        text: 'hello',
      },
    })).rejects.toThrow('Connector runtime endpoint not registered: acp:acp:hermes');
  });

  it('projects connector endpoint events with an explicit connector SessionIdentity', async () => {
    const service = await createServiceWithConnectedAcpEndpoint();
    const sessionIdentity = createClaudeCodeSessionIdentity();

    const [message] = await service.consumeEndpointConversationEvent(sessionIdentity.endpoint, {
      method: 'session/message',
      params: {
        sessionKey: 'claude-code:session:1',
        sessionIdentity,
        runId: 'run-1',
        text: 'hello',
        status: 'final',
      },
    });

    expect(message).toMatchObject({
      sessionUpdate: 'session_item',
      sessionKey: 'claude-code:session:1',
      item: {
        kind: 'assistant-turn',
        runId: 'run-1',
        text: 'hello',
      },
      snapshot: {
        catalog: {
          sessionIdentity,
        },
      },
    });
  });

  it('loads transcript history through ACP replay projection', async () => {
    const transcript = [
      JSON.stringify({ timestamp: 1, message: { role: 'user', content: '历史问题', id: 'u1', metadata: { runId: 'run-history' } } }),
      JSON.stringify({ timestamp: 2, message: { role: 'assistant', content: [{ type: 'text', text: '历史回答' }], id: 'a1', metadata: { runId: 'run-history' } } }),
    ].join('\n');
    const service = createService({
      sessionStorage: {
        listStorageDescriptors: async () => [],
        findStorageDescriptor: async () => null,
        getTranscriptFingerprint: async () => null,
        readTranscriptContent: async (identity) => (identity.sessionKey === 'agent:main:main' ? transcript : null),
        readTranscriptDescriptorContent: async () => null,
        readTranscriptLines: async function* (identity) {
          if (identity.sessionKey === 'agent:main:main') {
            yield* transcript.split('\n');
          }
        },
        readTranscriptDescriptorLines: async function* () {},
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
        upsertSessionIdentity: async () => true,
      },
    });
    await service.createSession({
      sessionKey: 'agent:main:main',
      endpoint: createOpenClawTestSessionIdentity('agent:main:main').endpoint,
      agentId: 'main',
    });

    const response = await service.executeSessionHydration({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main', 'main'),
      snapshot: { kind: 'latest' },
    });

    expect(response.snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant-turn', text: '历史回答' }),
    ]));
    expect(response.snapshot.replayComplete).toBe(true);
  });

  it('keeps cached session state instead of replaying transcript history into it', async () => {
    const chatSend = vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.idempotencyKey,
      status: 'started',
    }));
    const service = createService({
      openclawBridge: {
        chatSend,
        gatewayRpc: async () => ({}),
      },
      sessionStorage: {
        listStorageDescriptors: async () => [],
        findStorageDescriptor: async () => null,
        getTranscriptFingerprint: async () => null,
        readTranscriptContent: async (identity) => (identity.sessionKey === 'agent:main:main'
          ? JSON.stringify({ timestamp: 1, message: { role: 'user', content: '你好', id: 'transcript-user' } })
          : null),
        readTranscriptDescriptorContent: async () => null,
        readTranscriptLines: async function* () {},
        readTranscriptDescriptorLines: async function* () {},
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
        upsertSessionIdentity: async () => true,
      },
    });

    await service.promptSession({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
      message: '你好',
      idempotencyKey: 'client-run-1',
    });
    await vi.waitFor(() => expect(chatSend).toHaveBeenCalledTimes(1));

    const response = await service.executeSessionHydration({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
      snapshot: { kind: 'latest' },
    });

    expect(response.snapshot.items.filter((item) => item.kind === 'user-message')).toMatchObject([
      { text: '你好', runId: 'client-run-1' },
    ]);
  });
});
