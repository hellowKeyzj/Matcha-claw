import { describe, expect, it } from 'vitest';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-load-execution';
import {
  createEmptySessionRecord,
  getSessionItems,
  projectSessionViewItems,
  reconcileSessionItems,
} from '@/stores/chat/store-state-helpers';
import { buildSessionIdentityKey } from '../../electron/desktop-contract/runtime-address';
import type { SessionWireItem } from '@/types/session/snapshot';
import type { SessionRenderItem } from '@/types/session/render-item';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
import type { ChatStoreState } from '@/stores/chat/types';
import {
  assistantItem,
  completeFact,
  mediaContent,
  omittedContent,
  sessionView,
  userItem,
} from './helpers/session-fixtures';

function createHistoryRuntimeHarness(): StoreHistoryCache {
  let runId = 0;
  return {
    getHistoryLoadRunId: () => runId,
    nextHistoryLoadRunId: () => {
      runId += 1;
      return runId;
    },
    replaceHistoryLoadAbortController: () => null,
    clearHistoryLoadAbortController: () => {},
    setHistoryLoadInFlight: () => {},
    clearHistoryLoadInFlight: () => {},
    historyFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createHistoryWindow(
  sessionKey: string,
  items: SessionWireItem[],
): HistoryWindowResult {
  const view = sessionView(sessionKey, {
    epoch: 2,
    seq: items.length,
    cursor: items.length,
    items: completeFact(items),
  });
  return {
    view,
    sessionIdentity: {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId: view.identity.agentId ?? 'main',
      sessionKey,
    },
    thinkingLevel: null,
  };
}

function createSessionRecordKeyByIdentityKey(
  loadedSessions: ChatStoreState['loadedSessions'],
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const recordKey of Object.keys(loadedSessions)) {
    const sessionIdentity = loadedSessions[recordKey]?.meta.sessionIdentity ?? {
      endpoint: {
        kind: 'native-runtime' as const,
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId: recordKey.split(':')[1] ?? 'main',
      sessionKey: recordKey,
    };
    index[buildSessionIdentityKey(sessionIdentity)] = recordKey;
  }
  return index;
}

function createStateHarness(state: ChatStoreState) {
  let currentState = {
    ...state,
    sessionRecordKeyByIdentityKey: state.sessionRecordKeyByIdentityKey
      ?? createSessionRecordKeyByIdentityKey(state.loadedSessions ?? {}),
  } as ChatStoreState;
  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(currentState) : partial;
    currentState = { ...currentState, ...patch } as ChatStoreState;
  };
  return {
    set,
    get: () => currentState,
  };
}

describe('chat history apply pipeline', () => {
  it('foreground apply writes authoritative SessionView items into the requested session', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: { [sessionKey]: createEmptySessionRecord() },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, [
      userItem('item-user-1', 'hello'),
      assistantItem('item-assistant-1', 'done', { runId: 'run-1' }),
    ]));

    expect(harness.get().loadedSessions[sessionKey]?.meta.historyStatus).toBe('ready');
    expect(getSessionItems(harness.get(), sessionKey)).toMatchObject([
      expect.objectContaining({ key: 'item-user-1', text: 'hello' }),
      expect.objectContaining({ key: 'item-assistant-1', text: 'done', runId: 'run-1' }),
    ]);
  });

  it('background apply only updates the target session', async () => {
    const currentSessionKey = 'agent:main:main';
    const requestedSessionKey = 'agent:worker:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const currentView = createHistoryWindow(currentSessionKey, [
      assistantItem('item-assistant-current', 'keep me'),
    ]).view;
    const currentProjectedItems = projectSessionViewItems(currentView);
    const harness = createStateHarness({
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: { ...createEmptySessionRecord(), items: [] },
        [requestedSessionKey]: createEmptySessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
    } as ChatStoreState);
    harness.set({ loadedSessions: {
      ...harness.get().loadedSessions,
      [currentSessionKey]: { ...harness.get().loadedSessions[currentSessionKey]!, items: currentProjectedItems as never },
    } });
    const currentItemsRef = getSessionItems(harness.get(), currentSessionKey);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey,
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(requestedSessionKey, [
      assistantItem('item-assistant-worker', 'worker update'),
    ]));

    expect(getSessionItems(harness.get(), currentSessionKey)).toBe(currentItemsRef);
    expect(getSessionItems(harness.get(), requestedSessionKey)).toMatchObject([
      expect.objectContaining({ key: 'item-assistant-worker', text: 'worker update' }),
    ]);
  });

  it('authoritative SessionView items replace stale local optimistic assistant placeholders', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          items: [{
            key: 'session:agent:main:main|assistant-turn:main:run-1:main',
            kind: 'assistant-turn',
            role: 'assistant',
            sessionKey,
            turnKey: 'main:run-1',
            laneKey: 'main',
            identitySource: 'client',
            identityMode: 'client',
            identityConfidence: 'weak',
            status: 'streaming',
            segments: [],
            thinking: null,
            tools: [],
            embeddedToolResults: [],
            text: '',
            images: [],
            attachedFiles: [],
            pendingState: 'typing',
            updatedAt: 1,
          }],
        },
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, [
      userItem('item-user-server-1', 'hello'),
      assistantItem('item-assistant-1', 'done'),
    ]));

    expect(getSessionItems(harness.get(), sessionKey)).toMatchObject([
      expect.objectContaining({ kind: 'user-message', key: 'item-user-server-1', text: 'hello' }),
      expect.objectContaining({ kind: 'assistant-turn', key: 'item-assistant-1', text: 'done' }),
    ]);
    expect(getSessionItems(harness.get(), sessionKey)).toHaveLength(2);
    expect(getSessionItems(harness.get(), sessionKey)).not.toContainEqual(
      expect.objectContaining({ identitySource: 'client', pendingState: 'typing' }),
    );
  });

  it('does not collapse repeated same-text authoritative SessionView items', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: { [sessionKey]: createEmptySessionRecord() },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, [
      userItem('item-user-server-1', 'hello'),
      userItem('item-user-server-2', 'hello'),
    ]));

    expect(getSessionItems(harness.get(), sessionKey)).toMatchObject([
      expect.objectContaining({ key: 'item-user-server-1', text: 'hello' }),
      expect.objectContaining({ key: 'item-user-server-2', text: 'hello' }),
    ]);
    expect(getSessionItems(harness.get(), sessionKey)).toHaveLength(2);
  });

  it('keeps a repeated same-text pending user when no new canonical user confirms it', () => {
    const sessionKey = 'agent:main:main';
    const pendingUser: SessionRenderItem = {
      key: 'renderer-user:client-2',
      kind: 'user-message',
      role: 'user',
      sessionKey,
      text: '你好',
      clientId: 'client-2',
      status: 'pending',
      createdAt: 3,
      updatedAt: 3,
      images: [],
      attachedFiles: [],
    };
    const currentItems = [
      ...projectSessionViewItems(sessionView(sessionKey, {
        items: completeFact([
          userItem('item-user-1', '你好'),
          assistantItem('item-assistant-1', 'done'),
        ]),
      })),
      pendingUser,
    ];
    const nextItems = projectSessionViewItems(sessionView(sessionKey, {
      items: completeFact([
        userItem('item-user-1', '你好'),
        assistantItem('item-assistant-1', 'done'),
      ]),
    }));

    expect(reconcileSessionItems(currentItems, nextItems)).toEqual([
      currentItems[0],
      currentItems[1],
      pendingUser,
    ]);
  });

  it('drops a pending user when the next canonical user confirms it by order', () => {
    const sessionKey = 'agent:main:main';
    const pendingUser: SessionRenderItem = {
      key: 'renderer-user:client-2',
      kind: 'user-message',
      role: 'user',
      sessionKey,
      text: '你好',
      clientId: 'client-2',
      status: 'pending',
      createdAt: 3,
      updatedAt: 3,
      images: [],
      attachedFiles: [],
    };
    const currentItems = [
      ...projectSessionViewItems(sessionView(sessionKey, {
        items: completeFact([
          userItem('item-user-1', '你好'),
          assistantItem('item-assistant-1', 'done'),
        ]),
      })),
      pendingUser,
    ];
    const nextItems = projectSessionViewItems(sessionView(sessionKey, {
      items: completeFact([
        userItem('item-user-1', '你好'),
        assistantItem('item-assistant-1', 'done'),
        userItem('item-user-2', '你好'),
      ]),
    }));

    expect(reconcileSessionItems(currentItems, nextItems)).toEqual([
      currentItems[0],
      currentItems[1],
      nextItems[2],
    ]);
  });

  it('projects attachment status from SessionView media facts without leaking unsafe references', () => {
    const items = projectSessionViewItems(sessionView('agent:main:main', {
      items: completeFact([
        userItem('item-user-1', 'upload', {
          content: [mediaContent('application/pdf', '/api/chat/media/outgoing/session-1/upload.pdf')],
        }),
        assistantItem('item-assistant-1', '', {
          segments: [
            mediaContent('image/png', 'file:///private/image.png'),
            omittedContent('unsafe_media'),
            omittedContent('thinking'),
            omittedContent('unknown'),
          ],
        }),
      ]),
    }));

    expect(items[0]).toMatchObject({
      kind: 'user-message',
      attachedFiles: [expect.objectContaining({
        fileName: 'upload.pdf',
        source: 'message-ref',
      })],
    });
    expect(items[1]).toMatchObject({
      kind: 'assistant-turn',
      segments: [{
        kind: 'media',
        attachedFiles: [{ attachmentStatus: 'unsafe-media-omitted' }],
      }, {
        kind: 'media',
        attachedFiles: [{ attachmentStatus: 'unsafe-media-omitted' }],
      }, {
        kind: 'media',
        attachedFiles: [{ attachmentStatus: 'thinking-omitted' }],
      }, {
        kind: 'media',
        attachedFiles: [{ attachmentStatus: 'unknown-omitted' }],
      }],
    });
    expect(JSON.stringify(items)).not.toContain('file:///private/image.png');
  });

  it('does not restore a renderer receipt when SessionView omits it', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const receipt = {
      key: 'renderer-receipt:run-attachment-1',
      kind: 'user-message' as const,
      role: 'user' as const,
      sessionKey,
      text: 'same text',
      runId: 'run-attachment-1',
      rendererReceiptRunId: 'run-attachment-1',
      createdAt: 1,
      images: [{ url: 'https://preview.example/receipt.png', mimeType: 'image/png' }],
      attachedFiles: [],
    };
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: { [sessionKey]: { ...createEmptySessionRecord(), items: [receipt] } },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, [
      userItem('item-user-server-1', 'same text'),
      assistantItem('item-assistant-attachment-1', '', { runId: 'run-attachment-1' }),
    ]));

    expect(getSessionItems(harness.get(), sessionKey)).toEqual([
      expect.objectContaining({ key: 'item-user-server-1', text: 'same text' }),
      expect.objectContaining({ key: 'item-assistant-attachment-1', runId: 'run-attachment-1' }),
    ]);
  });

  it('keeps an attachment receipt when only an assistant item carries its run id', () => {
    const receipt = {
      key: 'renderer-receipt:run-attachment-1',
      kind: 'user-message' as const,
      role: 'user' as const,
      sessionKey: 'agent:main:main',
      runId: 'run-attachment-1',
      rendererReceiptRunId: 'run-attachment-1',
      text: 'same text',
      images: [],
      attachedFiles: [],
    };
    const assistant = {
      key: 'assistant:run-attachment-1',
      kind: 'assistant-turn' as const,
      role: 'assistant' as const,
      sessionKey: 'agent:main:main',
      runId: 'run-attachment-1',
      identitySource: 'run' as const,
      identityMode: 'run' as const,
      identityConfidence: 'strong' as const,
      status: 'streaming' as const,
      segments: [],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [],
    };

    expect(reconcileSessionItems([receipt], [assistant])).toEqual([assistant, receipt]);
  });

  it('clears renderer items when the canonical SessionView is empty', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          items: [{
            key: `session:${sessionKey}|assistant-turn:main:run-1:main`,
            kind: 'assistant-turn',
            sessionKey,
            role: 'assistant',
            turnKey: 'main:run-1',
            laneKey: 'main',
            identitySource: 'run',
            identityMode: 'run',
            identityConfidence: 'strong',
            status: 'streaming',
            segments: [],
            thinking: null,
            tools: [],
            embeddedToolResults: [],
            text: '',
            images: [],
            attachedFiles: [],
            pendingState: 'typing',
            updatedAt: 1,
          }],
          runtime: {
            ...createEmptySessionRecord().runtime,
            activeRunId: 'run-1',
            runPhase: 'submitted',
            pendingTurnKey: 'main:run-1',
            pendingTurnLaneKey: 'main',
          },
        },
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);
    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });
    await applyLoadedMessages(createHistoryWindow(sessionKey, []));

    expect(getSessionItems(harness.get(), sessionKey)).toEqual([]);
  });
});
