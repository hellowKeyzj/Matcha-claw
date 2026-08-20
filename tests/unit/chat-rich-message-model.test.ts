import { describe, expect, it } from 'vitest';
import { richTimelineItems } from '@/stores/chat/history-fetch-helpers';
import { patchSessionSnapshot } from '@/stores/chat/store-state-helpers';
import type { SessionRenderItem } from '@/types/session/render-item';
import type { SessionStateSnapshot } from '@/types/session/snapshot';
import type { RichTimelineMessage } from '@/stores/chat/history-fetch-helpers';

const sessionKey = 'agent:main:rich-model';

function assistant(messageId: string, content: NonNullable<RichTimelineMessage['content']>, extra: Partial<RichTimelineMessage> = {}): RichTimelineMessage {
  return {
    role: 'assistant',
    messageId,
    text: '',
    content,
    ...extra,
  };
}

function assistantItem(items: SessionRenderItem[]): Extract<SessionRenderItem, { kind: 'assistant-turn' }> {
  const item = items.find((candidate) => candidate.kind === 'assistant-turn');
  if (!item || item.kind !== 'assistant-turn') throw new Error('expected assistant turn');
  return item;
}

describe('rich renderer message model', () => {
  it('preserves thinking → message → tool → result → media order', () => {
    const items = richTimelineItems(sessionKey, [
      assistant('turn-1', [
        { kind: 'thinking', text: '先判断。' },
        { kind: 'text', text: '开始处理。' },
        { kind: 'toolUse', name: 'lookup', toolCallId: 'tool-1' },
      ]),
      {
        role: 'tool_result',
        messageId: 'result-1',
        toolCallId: 'tool-1',
        text: '找到结果',
      },
      assistant('media-1', [
        { kind: 'media', mediaType: 'image/png', reference: 'https://cdn.example/result.png' },
      ]),
    ]);

    const turns = items.filter((item): item is Extract<SessionRenderItem, { kind: 'assistant-turn' }> => item.kind === 'assistant-turn');
    expect(turns.flatMap((turn) => turn.segments.map((segment) => segment.kind))).toEqual([
      'thinking', 'message', 'tool', 'media',
    ]);
    expect(turns[0]?.segments).toMatchObject([
      { kind: 'thinking', text: '先判断。' },
      { kind: 'message', text: '开始处理。' },
      { kind: 'tool', tool: { id: 'tool-1', status: 'completed', summary: '找到结果' } },
    ]);
    expect(turns[1]?.segments).toMatchObject([
      { kind: 'media', images: [{ url: 'https://cdn.example/result.png', mimeType: 'image/png' }] },
    ]);
  });

  it('keeps tool-only turns visible and gives parallel tools stable IDs', () => {
    const content = [
      { kind: 'toolUse' as const, name: 'read', toolCallId: 'tool-a' },
      { kind: 'toolUse' as const, name: 'grep', toolCallId: 'tool-b' },
    ];
    const messages: RichTimelineMessage[] = [
      assistant('tools-1', content),
      { role: 'tool_result', messageId: 'result-b', toolCallId: 'tool-b', text: 'b done' },
      { role: 'tool_result', messageId: 'result-a', toolCallId: 'tool-a', text: 'a done' },
    ];
    const first = assistantItem(richTimelineItems(sessionKey, messages));
    const second = assistantItem(richTimelineItems(sessionKey, messages));

    expect(first.text).toBe('');
    expect(first.segments.map((segment) => segment.kind)).toEqual(['tool', 'tool']);
    expect(first.tools.map((tool) => [tool.id, tool.status])).toEqual([
      ['tool-a', 'completed'],
      ['tool-b', 'completed'],
    ]);
    expect(first.segments.map((segment) => segment.kind === 'tool' ? segment.tool.id : '')).toEqual([
      'tool-a', 'tool-b',
    ]);
    expect(second.segments.map((segment) => segment.key)).toEqual(first.segments.map((segment) => segment.key));
    expect(second.tools.map((tool) => tool.id)).toEqual(['tool-a', 'tool-b']);
  });

  it('projects system text and user media without accepting private paths', () => {
    const items = richTimelineItems(sessionKey, [
      {
        role: 'system',
        messageId: 'system-1',
        text: '系统提示',
        content: [{ kind: 'media', mediaType: 'text/plain', reference: 'C:\\private\\secret.txt' }],
      },
      {
        role: 'user',
        messageId: 'user-1',
        text: '请看图',
        content: [
          { kind: 'media', mediaType: 'image/jpeg', reference: '/api/media/user-1' },
          { kind: 'media', mediaType: 'image/png', reference: 'file:///private/raw.png' },
        ],
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'system', text: '系统提示' });
    expect(items[1]).toMatchObject({
      kind: 'user-message',
      images: [{ url: '/api/media/user-1', mimeType: 'image/jpeg' }],
    });
    expect(JSON.stringify(items)).not.toContain('private');
    expect(JSON.stringify(items)).not.toContain('file:///');
  });

  it('retains tools when rich history items are applied through a session snapshot', () => {
    const richItem = assistantItem(richTimelineItems(sessionKey, [assistant('history-1', [
      { kind: 'text', text: '历史消息' },
      { kind: 'toolUse', name: 'inspect', toolCallId: 'history-tool' },
      { kind: 'toolResult', toolCallId: 'history-tool', toolName: 'inspect', summary: '完成' },
    ])]));
    const state = {
      loadedSessions: {
        [sessionKey]: {
          meta: {
            backendSessionKey: sessionKey,
            runtimeScopeKey: 'native-runtime:openclaw:local',
            agentId: 'main',
            protocolId: 'openclaw-v4',
            runtimeEndpointId: 'local',
            sessionIdentity: { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey },
            kind: 'session', preferred: false, label: null, titleSource: 'none', historyStatus: 'ready', thinkingLevel: null,
          },
          runtime: {
            activeRunId: null, runPhase: 'idle', activeTurnItemKey: null, pendingTurnKey: null,
            pendingTurnLaneKey: null, lastUserMessageAt: null, runtimeActivity: null,
            lastError: null, lastIssue: null, updatedAt: null,
          },
          items: [],
          window: { totalItemCount: 0, windowStartOffset: 0, windowEndOffset: 0, hasMore: false, hasNewer: false, isAtLatest: true },
        },
      },
    } as never;
    const snapshot = {
      sessionKey,
      catalog: {
        key: sessionKey, agentId: 'main', protocolId: 'openclaw-v4', runtimeEndpointId: 'local',
        sessionIdentity: { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey },
        kind: 'session', preferred: false, titleSource: 'none',
      },
      items: [richItem], usage: [], artifacts: [], replayComplete: true,
      runtime: { activeRunId: null, runPhase: 'idle', activeTurnItemKey: null, pendingTurnKey: null, pendingTurnLaneKey: null, runtimeActivity: null, lastUserMessageAt: null, lastError: null, lastIssue: null, updatedAt: null },
      window: { totalItemCount: 1, windowStartOffset: 0, windowEndOffset: 1, hasMore: false, hasNewer: false, isAtLatest: true },
    } as SessionStateSnapshot;

    const next = patchSessionSnapshot(state, sessionKey, snapshot)[sessionKey]!.items;
    expect(next[0]).toMatchObject({ kind: 'assistant-turn', segments: [
      { kind: 'message', text: '历史消息' },
      { kind: 'tool', tool: { id: 'history-tool', status: 'completed', summary: '完成' } },
    ] });
  });

  it('does not project raw provider fields such as path or raw into renderer items', () => {
    const privateMessage = {
      ...assistant('redacted-1', [
        { kind: 'toolUse' as const, name: 'read', toolCallId: 'private-tool' },
        { kind: 'toolResult' as const, toolCallId: 'private-tool', summary: 'safe summary' },
      ]),
      path: 'C:\\workspace\\secret.txt',
      raw: { token: 'secret-token', path: '/private/raw' },
    } as RichTimelineMessage & Record<string, unknown>;
    const [item] = richTimelineItems(sessionKey, [privateMessage]);

    expect(JSON.stringify(item)).toContain('safe summary');
    expect(JSON.stringify(item)).not.toContain('secret.txt');
    expect(JSON.stringify(item)).not.toContain('secret-token');
    expect(JSON.stringify(item)).not.toContain('raw');
    expect('path' in item!).toBe(false);
  });
});
