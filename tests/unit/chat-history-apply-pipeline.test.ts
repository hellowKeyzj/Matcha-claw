import { describe, expect, it } from 'vitest';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-load-execution';
import {
  createEmptySessionRecord,
  getSessionItems,
  projectSessionViewItems,
  reconcileSessionItems,
} from '@/stores/chat/store-state-helpers';
import type { SessionWireItem } from '@/types/session/snapshot';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
import type { ChatStoreState } from '@/stores/chat/types';
import {
  assistantItem,
  completeFact,
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

function createStateHarness(state: ChatStoreState) {
  let currentState = state;
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
