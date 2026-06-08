import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatAssistantTurn } from '@/pages/Chat/ChatAssistantTurn';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { ChatAssistantTurnItem } from '@/pages/Chat/chat-render-item-model';

const invokeIpcMock = vi.fn();
const hostFileStatMock = vi.fn();
const sessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'openclaw:default',
  },
  agentId: 'files',
  sessionKey: 'files:test',
};

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostFileStat: (...args: unknown[]) => hostFileStatMock(...args),
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
    hostFileStatMock.mockReset();
    hostFileStatMock.mockResolvedValue({
      ok: true,
      entry: {
        name: 'default',
        path: '/tmp/default',
        isDir: false,
        size: 1024,
        mtimeMs: 1,
      },
    });
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

  it('legacy markdown relative file link should stay actionable when attached absolute path exists', () => {
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

    const actionable = screen.queryByRole('link', { name: 'TOOLS.md' })
      ?? screen.getByRole('button', { name: /TOOLS\.md/i });
    fireEvent.click(actionable);

    expect(invokeIpcMock).toHaveBeenCalled();
    expect(invokeIpcMock.mock.calls.some(([channel, value]) => (
      (channel === 'shell:showItemInFolder' || channel === 'shell:openPath') && value === targetPath
    ))).toBe(true);
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

  it('derives pdf artifact cards from assistant text and opens through artifact callback', async () => {
    const onOpenAttachedArtifact = vi.fn();
    hostFileStatMock.mockResolvedValueOnce({
      ok: true,
      entry: {
        name: 'report.pdf',
        path: '/tmp/report.pdf',
        isDir: false,
        size: 4096,
        mtimeMs: 1,
      },
    });
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成报告，位置： /tmp/report.pdf',
    };

    render(
      <ChatAssistantTurn
        item={buildItem(message)}
        showThinking={false}
        sessionIdentity={sessionIdentity}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    const fileButton = await screen.findByRole('button', { name: /report\.pdf/i });
    fireEvent.click(fileButton);
    expect(onOpenAttachedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/report.pdf',
      mimeType: 'application/pdf',
    }));
    expect(invokeIpcMock).not.toHaveBeenCalledWith('shell:openPath', '/tmp/report.pdf');
  });

  it('derived image artifact without an inline preview renders as an openable file card', async () => {
    const onOpenAttachedArtifact = vi.fn();
    hostFileStatMock.mockResolvedValueOnce({
      ok: true,
      entry: {
        name: 'chart.png',
        path: '/tmp/chart.png',
        isDir: false,
        size: 4096,
        mtimeMs: 1,
      },
    });
    const message: RawMessage = {
      role: 'assistant',
      content: '图片已生成： /tmp/chart.png',
    };

    render(
      <ChatAssistantTurn
        item={buildItem(message)}
        showThinking={false}
        sessionIdentity={sessionIdentity}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    const fileButton = await screen.findByRole('button', { name: /chart\.png/i });
    expect(screen.queryByTestId('chat-missing-image-preview')).toBeNull();
    fireEvent.click(fileButton);
    expect(onOpenAttachedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/chart.png',
      mimeType: 'image/png',
    }));
  });

  it('opens derived pdf artifact cards on pointer down to match real pointer interaction', async () => {
    const onOpenAttachedArtifact = vi.fn();
    hostFileStatMock.mockResolvedValueOnce({
      ok: true,
      entry: {
        name: 'report.pdf',
        path: '/tmp/report.pdf',
        isDir: false,
        size: 4096,
        mtimeMs: 1,
      },
    });
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成报告，位置： /tmp/report.pdf',
    };

    render(
      <ChatAssistantTurn
        item={buildItem(message)}
        showThinking={false}
        sessionIdentity={sessionIdentity}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    const fileButton = await screen.findByRole('button', { name: /report\.pdf/i });
    fireEvent.pointerDown(fileButton, { button: 0 });
    expect(onOpenAttachedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/report.pdf',
      mimeType: 'application/pdf',
    }));
  });

  it('opens derived pdf artifact cards on real mouse click with non-zero detail', async () => {
    const onOpenAttachedArtifact = vi.fn();
    hostFileStatMock.mockResolvedValueOnce({
      ok: true,
      entry: {
        name: 'report.pdf',
        path: '/tmp/report.pdf',
        isDir: false,
        size: 4096,
        mtimeMs: 1,
      },
    });
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成报告，位置： /tmp/report.pdf',
    };

    render(
      <ChatAssistantTurn
        item={buildItem(message)}
        showThinking={false}
        sessionIdentity={sessionIdentity}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    const fileButton = await screen.findByRole('button', { name: /report\.pdf/i });
    fireEvent.click(fileButton, { detail: 1, button: 0 });
    expect(onOpenAttachedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/report.pdf',
      mimeType: 'application/pdf',
    }));
  });

  it('derives skill directory cards from assistant text after stat validation', async () => {
    hostFileStatMock.mockResolvedValueOnce({
      ok: true,
      entry: {
        name: 'open-eastmoney',
        path: '~/.openclaw/skills/open-eastmoney',
        isDir: true,
        size: 0,
        mtimeMs: 1,
      },
    });
    const message: RawMessage = {
      role: 'assistant',
      content: '位置： ~/.openclaw/skills/open-eastmoney',
    };

    render(<ChatAssistantTurn item={buildItem(message)} showThinking={false} sessionIdentity={sessionIdentity} />);

    await waitFor(() => {
      expect(hostFileStatMock).toHaveBeenCalledWith({
        path: '~/.openclaw/skills/open-eastmoney',
        sessionIdentity,
      });
    });
    expect(await screen.findByRole('button', { name: /open-eastmoney/i })).toBeInTheDocument();
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

  it('assistant streaming settle keeps long markdown rendered after finalization', () => {
    const content = Array.from(
      { length: 60 },
      (_, index) => `- line ${index}: [OpenAI Stable](https://openai.com/?stable=${index})`,
    ).join('\n');
    const message: RawMessage = {
      role: 'assistant',
      id: 'assistant-stream-stable-body-1',
      messageId: 'turn-stream-stable-body-1',
      content,
    };

    const view = render(
      <ChatAssistantTurn
        item={buildItem({ ...message, streaming: true })}
        showThinking={false}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'OpenAI Stable' }).length).toBeGreaterThan(0);

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(screen.getAllByRole('link', { name: 'OpenAI Stable' }).length).toBeGreaterThan(0);
  });

  it('assistant streaming text remains visible after settle without losing content', () => {
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

    expect(view.container.textContent).toContain('stream body');

    view.rerender(<ChatAssistantTurn item={buildItem(message)} showThinking={false} />);

    expect(view.container.textContent).toContain('stream body');
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

  it('assistant markdown remains rich when a tool card splits a code fence boundary', () => {
    const item: ChatAssistantTurnItem = {
      key: 'assistant-turn:split-fence',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      laneKey: 'main',
      turnKey: 'run-split-fence',
      identitySource: 'run',
      identityMode: 'run',
      identityConfidence: 'strong',
      status: 'final',
      segments: [
        {
          kind: 'message',
          key: 'message:run-split-fence:main:0',
          text: '先给配置：\n\n```json\n{"enabled":true}\n',
        },
        {
          kind: 'tool',
          key: 'tool:run-split-fence:main:tool-read',
          tool: {
            id: 'tool-read',
            toolCallId: 'tool-read',
            name: 'read',
            displayTitle: 'Read',
            input: { filePath: 'README.md' },
            status: 'completed',
            result: {
              kind: 'none',
              surface: 'tool-card',
            },
          },
        },
        {
          kind: 'message',
          key: 'message:run-split-fence:main:1',
          text: '```\n\n---\n\n## 配置写入口也找到了\n\n- 可以继续改。',
        },
      ],
      thinking: null,
      tools: [],
      text: '先给配置：\n\n```json\n{"enabled":true}\n```\n\n---\n\n## 配置写入口也找到了\n\n- 可以继续改。',
      images: [],
      attachedFiles: [],
    };

    render(<ChatAssistantTurn item={item} showThinking={false} />);

    expect(screen.getByRole('heading', { name: '配置写入口也找到了' })).toBeInTheDocument();
  });
});
