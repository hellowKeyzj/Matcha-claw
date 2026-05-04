import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatAssistantTurn } from '@/pages/Chat/ChatAssistantTurn';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

function buildItem(message: RawMessage) {
  const item = applyAssistantPresentationToItems({
    items: buildRenderItemsFromMessages('agent:test:main', [message]),
    agents: [],
    defaultAssistant: null,
  })[0];
  if (!item || item.kind !== 'assistant-turn') {
    throw new Error('expected assistant turn');
  }
  return item;
}

describe('chat message links', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
  });

  it('plain text file name should open mapped absolute path from attached files', () => {
    const targetPath = 'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md';
    const message: RawMessage = {
      role: 'assistant',
      content: '搞定！已经写进 TOOLS.md 了',
      _attachedFiles: [
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: targetPath,
        },
      ],
    };
    prewarmAssistantMarkdownBody(buildItem(message));

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    fireEvent.click(screen.getByRole('button', { name: /TOOLS\.md/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:openPath', targetPath);
  });

  it('legacy markdown relative file link should open mapped absolute path from attached files', () => {
    const targetPath = 'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md';
    const message: RawMessage = {
      role: 'assistant',
      content: '[TOOLS.md](TOOLS.md)',
      _attachedFiles: [
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: targetPath,
        },
      ],
    };
    prewarmAssistantMarkdownBody(buildItem(message));

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    fireEvent.click(screen.getAllByText('TOOLS.md')[0]);

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', targetPath);
  });

  it('legacy markdown relative file link should not be clickable without attached absolute path', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[TOOLS.md](TOOLS.md)',
    };

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.queryByRole('button', { name: 'TOOLS.md' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'TOOLS.md' })).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('http links should remain external links', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
    };
    prewarmAssistantMarkdownBody(buildItem(message));

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    const link = screen.getByRole('link', { name: 'OpenAI' });
    expect(link).toHaveAttribute('href', 'https://openai.com');
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(link);
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('attached file card should open file directly when filePath exists', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '文件已生成',
      _attachedFiles: [
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1234,
          preview: null,
          filePath: 'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md',
        },
      ],
    };

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    fireEvent.click(screen.getByRole('button', { name: /TOOLS\.md/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:openPath',
      'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md',
    );
  });

  it('heavy assistant markdown should render rich content immediately', () => {
    const longMarkdown = Array.from(
      { length: 80 },
      (_, index) => `line-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n');
    const message: RawMessage = {
      role: 'assistant',
      content: longMarkdown,
    };
    prewarmAssistantMarkdownBody(buildItem(message));

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();
  });

  it('assistant streaming message should render markdown links in real time', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
      streaming: true,
    };

    render(
      <ChatAssistantTurn
        item={buildItem(message)}
        showThinking={false}
      />,
    );

    const link = screen.getByRole('link', { name: 'OpenAI' });
    expect(link).toHaveAttribute('href', 'https://openai.com');
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();
  });

  it('assistant plain markdown miss should render rich markdown immediately without raw-text fallback', () => {
    const content = '[OpenAI Miss](https://openai.com/?miss=1)';
    const message: RawMessage = {
      role: 'assistant',
      content,
    };

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getByRole('link', { name: 'OpenAI Miss' })).toHaveAttribute('href', 'https://openai.com/?miss=1');
    expect(screen.queryByText(content)).toBeNull();
  });

  it('assistant streaming settle should switch to final markdown immediately without plain-text flash', () => {
    const content = '[OpenAI Stream Final](https://openai.com/?stream-final=1)';
    const message: RawMessage = {
      role: 'assistant',
      content,
    };

    const view = render(
      <ChatAssistantTurn
        item={buildItem({ ...message, streaming: true })}
        showThinking={false}
      />,
    );

    expect(screen.getByRole('link', { name: 'OpenAI Stream Final' })).toHaveAttribute('href', 'https://openai.com/?stream-final=1');

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getByRole('link', { name: 'OpenAI Stream Final' })).toHaveAttribute('href', 'https://openai.com/?stream-final=1');
    expect(screen.queryByText(content)).toBeNull();
  });

  it('assistant streaming text keeps a single body skeleton when settling', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'stream body',
    };

    const view = render(
      <ChatAssistantTurn
        item={buildItem({ ...message, streaming: true })}
        showThinking={false}
      />,
    );

    const streamingBody = view.container.querySelector('[data-chat-body-mode=\"streaming\"] > div');
    expect(streamingBody?.children).toHaveLength(1);

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    const settledBody = view.container.querySelector('[data-chat-body-mode=\"settled\"] > div');
    expect(settledBody?.children).toHaveLength(1);
  });

  it('assistant streaming plain csv should keep the same markdown body after settle', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        'Task,Week,Owner,Status',
        '梳理当前主转化与次转化,Week 1,Ada,未开始',
        '补充导出60天搜索词趋势,Week 1,Bob,未开始',
        '输出Week 2整改小结,Week 2,Cindy,进行中',
      ].join('\n'),
    };

    const view = render(
      <ChatAssistantTurn
        item={buildItem({ ...message, streaming: true })}
        showThinking={false}
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('Task,Week,Owner,Status') ?? false
    )).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('Task,Week,Owner,Status') ?? false
    )).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('assistant streaming markdown table should keep the same markdown body after settle', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        '| Task | Owner | Status |',
        '| --- | --- | --- |',
        '| Build UI | Ada | Done |',
        '| Fix scroll | Bob | Doing |',
      ].join('\n'),
    };

    const view = render(
      <ChatAssistantTurn
        item={buildItem({ ...message, streaming: true })}
        showThinking={false}
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Build UI' })).toBeInTheDocument();

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Build UI' })).toBeInTheDocument();
  });
});

