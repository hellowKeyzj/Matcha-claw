import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatList } from '@/pages/Chat/components/ChatList';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { buildRenderItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { RawMessage } from './helpers/timeline-fixtures';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';
import { createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function buildCurrentSession(messages: RawMessage[]) {
  const base = createEmptySessionRecord();
  const items = buildRenderItemsFromMessages('agent:test:main', messages);
  return {
    runtime: {
      ...base.runtime,
      activeRunId: 'run-1',
      runPhase: 'submitted' as const,
    },
    items: applyAssistantPresentationToItems({
      items,
      agents: [],
      defaultAssistant: { agentId: 'test', agentName: 'Test Agent' },
    }),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

function buildStreamingShellSession() {
  const state = createEmptyCanonicalSessionState('agent:test:main', createOpenClawTestRuntimeContext('agent:test:main'));
  reduceCanonicalSessionEvents(state, [{
    eventId: 'assistant-empty-stream',
    type: 'message_snapshot',
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    source: 'live',
    sessionId: 'agent:test:main',
    runId: 'run-1',
    laneKey: 'main',
    origin: {
      runtimeEventType: 'test',
      runtimeIds: { sessionKey: 'agent:test:main' },
    },
    role: 'assistant',
    content: '',
    text: '',
    status: 'streaming',
  }]);
  const items = buildRenderItemsFromCanonicalState({ state }).map((item) => (
    item.kind === 'assistant-turn'
      ? { ...item, pendingState: 'typing' as const }
      : item
  ));
  return {
    runtime: state.runtime,
    items: applyAssistantPresentationToItems({
      items,
      agents: [],
      defaultAssistant: { agentId: 'test', agentName: 'Test Agent' },
    }),
    window: createViewportWindowState({
      totalItemCount: items.length,
      windowStartOffset: 0,
      windowEndOffset: items.length,
      isAtLatest: true,
    }),
  };
}

describe('chat list streaming render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('updates the active assistant row immediately when the streaming target text grows', () => {
    const now = Date.now() / 1000;
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const view = render(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).runtime}
        viewport={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).window}
        items={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk') ?? false
    )).length).toBeGreaterThan(0);

    view.rerender(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).runtime}
        viewport={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).window}
        items={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk second chunk') ?? false
    )).length).toBeGreaterThan(0);
    expect(rafQueue).toHaveLength(0);
  });

  it('renders a single assistant streaming shell before the first assistant token lands', () => {
    const streamingShellSession = buildStreamingShellSession();

    render(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={streamingShellSession.runtime}
        viewport={streamingShellSession.window}
        items={streamingShellSession.items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getByTestId('assistant-message-avatar')).toBeInTheDocument();
    expect(document.querySelector('[data-chat-pending-mode="typing"]')).not.toBeNull();
  });
});

