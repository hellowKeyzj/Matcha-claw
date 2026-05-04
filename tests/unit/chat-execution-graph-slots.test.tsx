import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function renderSurface(items: SessionRenderItem[]) {
  return render(
    <ChatListSurface
      messagesViewportRef={{ current: null }}
      messageContentRef={{ current: null }}
      isEmptyState={false}
      showBlockingLoading={false}
      showBlockingError={false}
      errorMessage={null}
      onPointerDown={() => {}}
      onScroll={() => {}}
      onTouchMove={() => {}}
      onWheel={() => {}}
      items={applyAssistantPresentationToItems({
        items,
        agents: [],
        defaultAssistant: null,
      })}
      showLoadOlder={false}
      isLoadingOlder={false}
      onLoadOlder={() => {}}
      loadOlderLabel="Load older"
      scrollChromeStore={createChatScrollChromeStore({
        isBottomLocked: true,
        visible: true,
        isAtLatest: true,
        jumpActionLabel: 'Jump',
      })}
      showThinking={false}
      userAvatarImageUrl={null}
      onJumpToItemKey={() => {}}
    />,
  );
}

describe('chat execution graph items', () => {
  it('renders execution graph items inline after their anchor message item', () => {
    const messageItems = buildRenderItemsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const items = [
      messageItems[0]!,
      messageItems[1]!,
      {
        key: 'session:agent:test:main|graph:graph-1',
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        createdAt: 2,
        updatedAt: 2,
        status: 'final' as const,
        laneKey: messageItems[1]!.laneKey,
        turnKey: messageItems[1]!.turnKey,
        agentId: messageItems[1]!.agentId,
        graphId: 'graph-1',
        completionItemKey: messageItems[1]!.key,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: messageItems[1]!.key,
      },
    ] satisfies SessionRenderItem[];

    renderSurface(items);

    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
  });
});
