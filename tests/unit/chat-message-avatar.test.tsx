import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatAssistantTurn } from '@/pages/Chat/ChatAssistantTurn';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildRenderItem(message: RawMessage) {
  return applyAssistantPresentationToItems({
    items: buildRenderItemsFromMessages('agent:test:main', [message]),
    agents: [{
      id: 'writer',
      agentName: 'Writer',
      avatarSeed: 'agent:writer',
      avatarStyle: 'bottts',
    }],
    defaultAssistant: null,
  })[0]!;
}

describe('chat message avatar', () => {
  it('assistant turn renders generated agent avatar', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: 'hello',
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const img = screen.getByTestId('assistant-message-avatar').querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Agent avatar');
    expect(img?.src.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('uses the OpenClaw-style assistant shrink layout instead of a fixed 80% shell', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: 'layout-check',
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain(CHAT_LAYOUT_TOKENS.messageShellAssistantColumns);

    const avatarShell = shell?.children[0] as HTMLElement | undefined;
    const contentShell = shell?.children[1] as HTMLElement | undefined;
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatar);
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentColumn);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentAssistantOrder);
    expect(contentShell?.className).not.toContain('max-w-[80%]');
    const body = container.querySelector('[data-chat-body-mode="settled"]') as HTMLElement | null;
    expect(body?.className).toContain(CHAT_LAYOUT_TOKENS.assistantSurface);
  });

  it('thinking and tool rails keep a stable width while expand/collapse only changes inner content', () => {
    const thinkingItem = buildRenderItem({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'reviewing options' }],
    });
    const toolItem = buildRenderItem({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tool-1', name: 'read', input: { filePath: 'README.md' } }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read',
        status: 'running',
        updatedAt: 1,
      }],
    });
    if (thinkingItem.kind !== 'assistant-turn' || toolItem.kind !== 'assistant-turn') {
      throw new Error('expected assistant turns');
    }

    const thinkingRender = render(
      <ChatAssistantTurn
        item={thinkingItem}
        showThinking
      />,
    );
    const toolRender = render(
      <ChatAssistantTurn
        item={toolItem}
        showThinking={false}
      />,
    );

    const thinkingCompactCard = thinkingRender.container.querySelector('[data-compact-rail="thinking"]') as HTMLElement | null;
    const toolCompactCard = toolRender.container.querySelector('[data-compact-rail="tool"]') as HTMLElement | null;
    expect(thinkingCompactCard).not.toBeNull();
    expect(toolCompactCard).not.toBeNull();
    expect(thinkingCompactCard?.className).toContain('w-[20rem]');
    expect(toolCompactCard?.className).toContain('w-[20rem]');

    const thinkingToggle = screen.getByLabelText('展开思考') as HTMLButtonElement | null;
    const toolToggle = screen.getByLabelText('展开工具 read') as HTMLButtonElement | null;
    act(() => {
      thinkingToggle?.click();
      toolToggle?.click();
    });

    expect(screen.getByText('输入参数')).toBeInTheDocument();
    expect(screen.getByText(/reviewing options/)).toBeInTheDocument();
  });

  it('tool-only assistant turn renders expandable tool cards without empty assistant body shell', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read',
        status: 'running',
        updatedAt: 1,
      }],
      streaming: true,
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    expect(container.querySelector('[data-chat-body-mode="streaming"]')).toBeNull();
    const toggle = screen.getByLabelText('展开工具 read') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.click();
    });
    expect(screen.getByText('输入参数')).toBeInTheDocument();
    expect(screen.getByText(/读取，README\.md/)).toBeInTheDocument();
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).toContain('读取，README.md');
  });

  it('tool card stays collapsed by default and expands to show tool output', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read',
        status: 'completed',
        updatedAt: 1,
        result: { text: 'tool output body' },
        outputText: '{"text":"tool output body"}',
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    expect(screen.queryByText('Tool call')).toBeNull();
    expect(screen.queryByText('Tool input')).toBeNull();
    const toolRail = document.querySelector('[data-compact-rail="tool"]');
    expect(toolRail?.textContent).toContain('读取，README.md');
    expect(toolRail?.textContent).toContain('完成');
    expect(toolRail?.textContent).toContain('tool output body');

    const toggle = screen.getByLabelText('展开工具 read') as HTMLButtonElement | null;
    act(() => {
      toggle?.click();
    });

    expect(screen.getByText('输入参数')).toBeInTheDocument();
    expect(document.querySelector('[data-compact-rail="tool"] > .ml-\\[1\\.15rem\\]')).toBeNull();

    const inputToggle = screen.getByLabelText('展开输入参数') as HTMLButtonElement | null;
    act(() => {
      inputToggle?.click();
    });
    expect(screen.getAllByText(/README\.md/).length).toBeGreaterThan(0);

    const outputToggle = screen.getByLabelText('展开输出结果') as HTMLButtonElement | null;
    act(() => {
      outputToggle?.click();
    });
    expect(screen.getAllByText(/tool output body/).length).toBeGreaterThan(0);
  });

  it('tool card renders json output as a collapsible JSON block', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-json-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-json-1',
        name: 'read',
        status: 'completed',
        updatedAt: 1,
        result: { text: 'tool output body', ok: true },
        outputText: '{"text":"tool output body","ok":true}',
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const toggle = screen.getByLabelText('展开工具 read') as HTMLButtonElement | null;
    act(() => {
      toggle?.click();
    });

    expect(screen.queryByText('Tool call')).toBeNull();
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).toContain('读取，README.md');
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).not.toContain('{ text, ok }');
    expect(screen.getByText('输出结果 · JSON')).toBeInTheDocument();
    expect(document.querySelector('[data-compact-rail="tool"] > .ml-\\[1\\.15rem\\]')).toBeNull();
    const outputToggle = screen.getByLabelText('展开输出结果') as HTMLButtonElement | null;
    act(() => {
      outputToggle?.click();
    });
    expect(screen.getAllByText(/tool output body/).length).toBeGreaterThan(0);
  });

  it('collapsed tool summary avoids exposing raw object-like payload text', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-raw-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-raw-1',
        name: 'read',
        status: 'completed',
        updatedAt: 1,
        result: "{'status': 'error', 'message': 'store_failed', 'tool': 'read'}",
        outputText: "{'status': 'error', 'message': 'store_failed', 'tool': 'read'}",
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const railText = document.querySelector('[data-compact-rail="tool"]')?.textContent ?? '';
    expect(railText).toContain('store_failed');
    expect(railText).not.toContain("{'status'");
  });

  it('collapsed tool header avoids exposing raw object-like input payload text', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-raw-input-1',
        name: 'multi-search-engine',
        input: "--- name: 'multi-search-engine' description: 'GitHub trending search' ---",
      }],
      toolStatuses: [{
        toolCallId: 'tool-raw-input-1',
        name: 'multi-search-engine',
        status: 'completed',
        updatedAt: 1,
        result: "{'status': 'error', 'tool': 'web_search', 'message': 'search_failed'}",
        outputText: "{'status': 'error', 'tool': 'web_search', 'message': 'search_failed'}",
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const railText = document.querySelector('[data-compact-rail="tool"]')?.textContent ?? '';
    expect(railText).toContain('GitHub trending search');
    expect(railText).not.toContain("--- name:");
    expect(railText).toContain('search_failed');
    expect(railText).not.toContain("{'status'");
  });

  it('clicking the assistant body collapses open thinking and tool sections in the same turn', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reviewing options' },
        { type: 'toolCall', id: 'tool-1', name: 'read', input: { filePath: 'README.md' } },
        { type: 'text', text: 'final answer body' },
      ],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read',
        status: 'completed',
        updatedAt: 1,
        result: { text: 'tool output body' },
        outputText: '{"text":"tool output body"}',
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking
      />,
    );

    act(() => {
      screen.getByLabelText('展开思考').click();
    });
    act(() => {
      screen.getByLabelText('展开工具 read').click();
    });
    act(() => {
      screen.getByLabelText('展开输入参数').click();
    });
    act(() => {
      screen.getByLabelText('展开输出结果').click();
    });

    expect(screen.getByText(/reviewing options/)).toBeInTheDocument();
    expect(screen.getAllByText(/README\.md/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tool output body/).length).toBeGreaterThan(0);

    act(() => {
      screen.getByText('final answer body').click();
    });

    expect(screen.queryByText(/reviewing options/)).toBeNull();
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).toContain('README.md');
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).toContain('tool output body');
  });

  it('long tool output uses its own scroll region instead of expanding the chat column indefinitely', () => {
    const longOutput = Array.from({ length: 80 }, (_, index) => `line-${index}: long tool output content`).join('\n');
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-long-output',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-long-output',
        name: 'read',
        status: 'completed',
        updatedAt: 1,
        result: { text: longOutput },
        outputText: JSON.stringify({ text: longOutput }),
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const toggle = screen.getByLabelText('展开工具 read') as HTMLButtonElement | null;
    act(() => {
      toggle?.click();
    });

    const outputToggle = screen.getByLabelText('展开输出结果') as HTMLButtonElement | null;
    act(() => {
      outputToggle?.click();
    });

    const scrollRegion = container.querySelector('[data-tool-output-scroll="true"]') as HTMLElement | null;
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion?.className).toContain('max-h-64');
    expect(scrollRegion?.className).toContain('overflow-y-auto');
  });

  it('tool card renders canvas preview with raw details disclosure', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-canvas-1',
        name: 'canvas_render',
        input: { source: { type: 'handle', id: 'cv-inline' } },
      }],
      toolStatuses: [{
        toolCallId: 'tool-canvas-1',
        name: 'canvas_render',
        status: 'completed',
        updatedAt: 1,
        result: {
          kind: 'canvas',
          view: {
            backend: 'canvas',
            id: 'cv-inline',
            url: '/__openclaw__/canvas/documents/cv_inline/index.html',
            title: 'Inline demo',
            preferred_height: 320,
          },
          presentation: {
            target: 'assistant_message',
          },
        },
        outputText: JSON.stringify({
          kind: 'canvas',
          view: {
            backend: 'canvas',
            id: 'cv-inline',
            url: '/__openclaw__/canvas/documents/cv_inline/index.html',
            title: 'Inline demo',
            preferred_height: 320,
          },
          presentation: {
            target: 'assistant_message',
          },
        }),
      }],
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const embeddedIframe = container.querySelector('iframe');
    expect(embeddedIframe).not.toBeNull();
    expect(embeddedIframe?.getAttribute('src')).toBe('/__openclaw__/canvas/documents/cv_inline/index.html');

    const toggle = screen.getByLabelText('展开工具 canvas_render') as HTMLButtonElement | null;
    expect(document.querySelector('[data-compact-rail="tool"]')?.textContent).toContain('已生成画布');
    act(() => {
      toggle?.click();
    });

    expect(screen.queryByText('预览已显示在助手消息里。')).toBeNull();
    const outputToggle = screen.getByLabelText('展开输出结果') as HTMLButtonElement | null;
    act(() => {
      outputToggle?.click();
    });
    expect(screen.getByText('预览已显示在助手消息里。')).toBeInTheDocument();
    const rawToggle = screen.getAllByLabelText('展开原始内容')[0] as HTMLButtonElement | null;
    expect(rawToggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      rawToggle?.click();
    });
    expect(rawToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText(/cv-inline/).length).toBeGreaterThan(0);
  });

  it('user message renders custom avatar image when provided', () => {
    const item = buildRenderItem({
      role: 'user',
      content: 'hi',
    });
    if (item.kind !== 'user-message') {
      throw new Error('expected user message');
    }
    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

    render(
      <ChatMessage
        item={item}
        userAvatarImageUrl={avatarDataUrl}
      />,
    );

    const img = screen.getByAltText('user-avatar') as HTMLImageElement;
    expect(img.src).toBe(avatarDataUrl);

    const shell = img.closest('.group') as HTMLElement | null;
    const avatarShell = shell?.children[0] as HTMLElement | undefined;
    const contentShell = shell?.children[1] as HTMLElement | undefined;
    expect(shell?.className).toContain(CHAT_LAYOUT_TOKENS.messageShellUserColumns);
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatarUserOrder);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentUserOrder);
  });

  it('renders user content as a light asymmetric card instead of the old secondary bubble', () => {
    const item = buildRenderItem({
      role: 'user',
      content: 'bubble-check',
    });
    if (item.kind !== 'user-message') {
      throw new Error('expected user message');
    }

    render(
      <ChatMessage
        item={item}
      />,
    );

    const bubble = screen.getByText('bubble-check').parentElement as HTMLElement | null;
    expect(bubble?.className).toContain(CHAT_LAYOUT_TOKENS.userBubble);
    expect(CHAT_LAYOUT_TOKENS.userBubble).toContain('rounded-tr-md');
    expect(CHAT_LAYOUT_TOKENS.userBubble).not.toContain('bg-secondary');
  });
});
