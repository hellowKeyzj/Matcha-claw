import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';
import { applyAssistantPresentationToRows } from '@/pages/Chat/chat-row-model';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import type { SessionRenderRow } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

function renderSurface(rows: SessionRenderRow[]) {
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
      rows={applyAssistantPresentationToRows({
        rows,
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
      onJumpToRowKey={() => {}}
    />,
  );
}

describe('chat execution graph rows', () => {
  it('renders execution graph rows inline after their anchor message row', () => {
    const messageRows = buildRenderRowsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const rows = [
      messageRows[0]!,
      messageRows[1]!,
      {
        key: 'session:agent:test:main|graph:graph-1',
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        status: 'final' as const,
        entryId: 'a1',
        assistantTurnKey: messageRows[1]!.turnKey ?? null,
        assistantLaneKey: messageRows[1]!.laneKey ?? null,
        assistantLaneAgentId: messageRows[1]!.agentId ?? null,
        graphId: 'graph-1',
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerRowKey: messageRows[1]!.key,
      },
    ] satisfies SessionRenderRow[];

    renderSurface(rows);

    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
  });
});
