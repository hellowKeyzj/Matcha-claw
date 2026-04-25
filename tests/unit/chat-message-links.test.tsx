import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
<<<<<<< ours
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
=======
<<<<<<< ours
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
=======
>>>>>>> theirs
>>>>>>> theirs
import type { RawMessage } from '@/stores/chat';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('chat message links', () => {
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

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('TOOLS.md')[0];
    fireEvent.click(linkText);
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getAllByText('TOOLS.md')[0]);
>>>>>>> theirs
>>>>>>> theirs

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', targetPath);
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

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('TOOLS.md')[0];
    fireEvent.click(linkText);
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getAllByText('TOOLS.md')[0]);
>>>>>>> theirs
>>>>>>> theirs

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', targetPath);
  });

  it('legacy markdown relative file link should not be clickable without attached absolute path', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[TOOLS.md](TOOLS.md)',
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);
>>>>>>> theirs
>>>>>>> theirs

    expect(screen.queryByRole('button', { name: 'TOOLS.md' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'TOOLS.md' })).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('file link should prefer absolute path from attached files when available', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '完成！已经更新了 SKILL.md',
      _attachedFiles: [
        {
          fileName: 'SKILL.md',
          mimeType: 'text/markdown',
          fileSize: 4096,
          preview: null,
          filePath: 'C:/Users/Mr.Key/.openclaw/skills/kdocs-task/SKILL.md',
        },
      ],
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('SKILL.md')[0];
    fireEvent.click(linkText);
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getAllByText('SKILL.md')[0]);
>>>>>>> theirs
>>>>>>> theirs

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:showItemInFolder',
      'C:/Users/Mr.Key/.openclaw/skills/kdocs-task/SKILL.md',
    );
  });

  it('same file name with duplicated same absolute path should resolve to the unique absolute path', () => {
    const targetPath = 'C:/Users/Mr.Key/.openclaw/skills/kdocs-task/SKILL.md';
    const message: RawMessage = {
      role: 'assistant',
      content: '已更新 [SKILL.md](SKILL.md)',
      _attachedFiles: [
        {
          fileName: 'SKILL.md',
          mimeType: 'text/markdown',
          fileSize: 4096,
          preview: null,
          filePath: targetPath,
        },
        {
          fileName: 'SKILL.md',
          mimeType: 'text/markdown',
          fileSize: 4096,
          preview: null,
          filePath: targetPath,
        },
      ],
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('SKILL.md')[0];
    fireEvent.click(linkText);

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:showItemInFolder',
      targetPath,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getAllByText('SKILL.md')[0]);

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', targetPath);
>>>>>>> theirs
>>>>>>> theirs
  });

  it('same file name with multiple absolute paths should resolve by stable order (first path)', () => {
    const firstPath = 'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md';
    const secondPath = 'C:/Users/Mr.Key/.openclaw/skills/kdocs-task/TOOLS.md';
    const message: RawMessage = {
      role: 'assistant',
      content: '请检查 TOOLS.md',
      _attachedFiles: [
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: firstPath,
        },
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: secondPath,
        },
      ],
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('TOOLS.md')[0];
    fireEvent.click(linkText);

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:showItemInFolder',
      firstPath,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getAllByText('TOOLS.md')[0]);

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', firstPath);
>>>>>>> theirs
>>>>>>> theirs
  });

  it('absolute path in text should not be clickable when path is not in attached files list', () => {
    const attachedPath = 'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md';
    const otherPath = 'C:/Users/Mr.Key/.openclaw/skills/kdocs-task/SKILL.md';
    const message: RawMessage = {
      role: 'assistant',
      content: `请查看 ${otherPath}`,
      _attachedFiles: [
        {
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: attachedPath,
        },
      ],
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);
>>>>>>> theirs
>>>>>>> theirs

    expect(screen.queryByRole('button', { name: otherPath })).toBeNull();
    expect(screen.queryByRole('link', { name: otherPath })).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('http links should remain external links', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);
>>>>>>> theirs
>>>>>>> theirs

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

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );
<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} />);
>>>>>>> theirs
>>>>>>> theirs

    fireEvent.click(screen.getByRole('button', { name: /TOOLS\.md/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:openPath',
      'C:/Users/Mr.Key/.openclaw/workspace/TOOLS.md',
    );
  });

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
  it('heavy assistant markdown should render rich content immediately', () => {
    const longMarkdown = Array.from(
      { length: 80 },
      (_, index) => `line-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n');
    const message: RawMessage = {
      role: 'assistant',
      content: longMarkdown,
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();
  });

  it('heavy assistant markdown should stay rich across remount without raw fallback', () => {
    const longMarkdown = Array.from(
      { length: 80 },
      (_, index) => `line-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n');
    const message: RawMessage = {
      role: 'assistant',
      content: longMarkdown,
      id: 'remount-rich-ready',
      timestamp: 1,
    };

    const firstMount = render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();

    firstMount.unmount();

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();
  });

  it('assistant streaming message should render markdown links in real time', () => {
<<<<<<< ours
=======
=======
  it('heavy assistant markdown should render full content immediately and keep full mode across remount', () => {
    const longMarkdown = Array.from(
      { length: 320 },
      (_, index) => `section-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n\n');
    const message: RawMessage = {
      role: 'assistant',
      content: longMarkdown,
      id: 'heavy-markdown-1',
      timestamp: 1,
    };

    const firstMount = render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Large message preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Render full formatting' })).toBeNull();
    expect(firstMount.container.querySelector('[data-chat-body-mode="full"]')).not.toBeNull();

    firstMount.unmount();

    render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Large message preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Render full formatting' })).toBeNull();
  });

  it('assistant streaming message should keep markdown as plain text until settled', () => {
>>>>>>> theirs
>>>>>>> theirs
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
    };

<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
    render(
      <ChatMessage
        message={message}
        showThinking={false}
        isStreaming
      />,
    );

    const link = screen.getByRole('link', { name: 'OpenAI' });
    expect(link).toHaveAttribute('href', 'https://openai.com');
    expect(screen.queryByText('[OpenAI](https://openai.com)')).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('extremely long assistant markdown should start in lite mode and upgrade on demand', () => {
    const hugeMarkdown = Array.from(
      { length: 320 },
      (_, index) => `section-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n\n');
    const message: RawMessage = {
      role: 'assistant',
      content: hugeMarkdown,
      id: 'huge-markdown-1',
      timestamp: 1,
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    expect(screen.getByText('Large message preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Render full formatting' })).toBeInTheDocument();
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Render full formatting' }));

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
  });

  it('extremely long assistant markdown can stay in shell mode until explicitly expanded', () => {
    clearUiTelemetry();
    const hugeMarkdown = Array.from(
      { length: 320 },
      (_, index) => `section-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n\n');
    const message: RawMessage = {
      role: 'assistant',
      content: hugeMarkdown,
      id: 'huge-shell-1',
      timestamp: 1,
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
        bodyRenderMode="shell"
      />,
    );

    expect(screen.getByText('Full markdown formatting is deferred until this message becomes active.')).toBeInTheDocument();
    expect(screen.getByText(/section-0:/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'OpenAI' })).toBeNull();
    expect(getUiTelemetrySnapshot(20).find((entry) => entry.event === 'chat.md_process_cost')).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Render full formatting' }));

    expect(screen.getAllByRole('link', { name: 'OpenAI' }).length).toBeGreaterThan(0);
  });

<<<<<<< ours
=======
=======
    render(<ChatMessage message={message} showThinking={false} isStreaming />);

    expect(screen.getByText('[OpenAI](https://openai.com)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'OpenAI' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('assistant streaming table markdown should not switch into structured preview before settle', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        '| Task | Owner | Status |',
        '| --- | --- | --- |',
        '| Build UI | Ada | Done |',
        '| Fix scroll | Bob | Doing |',
      ].join('\n'),
    };

    const view = render(<ChatMessage message={message} showThinking={false} isStreaming />);

    expect(screen.getByText((_, element) => (
      element?.textContent?.includes('| Task | Owner | Status |') ?? false
    ))).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    view.rerender(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
  });

  it('renders fenced csv blocks as table preview while preserving surrounding markdown', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        '下面是可导入的 CSV：',
        '```csv',
        'Task,Owner,Status',
        'Build UI,Ada,Done',
        'Fix scroll,Bob,Doing',
        '```',
        '',
        '[OpenAI](https://openai.com)',
      ].join('\n'),
    };

    const { container } = render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getByText('下面是可导入的 CSV：')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByText('Build UI')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute('href', 'https://openai.com');
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.queryByText('CSV Preview')).toBeNull();
    expect(screen.getByRole('button', { name: '复制 CSV' })).toBeInTheDocument();
  });

  it('renders plain csv blocks as table preview for real chat output shape', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        '下面我直接给你一版 可直接复制进 Notion / Excel / 飞书多维表的 CSV 导入版。',
        '',
        'Task,Week,Owner,Status',
        '梳理当前主转化与次转化,Week 1,Ada,未开始',
        '补充导出60天搜索词趋势,Week 1,Bob,未开始',
        '输出Week 2整改小结,Week 2,Cindy,进行中',
      ].join('\n'),
    };

    render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getByText(/CSV 导入版/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByText('梳理当前主转化与次转化')).toBeInTheDocument();
    expect(screen.queryByText('Task,Week,Owner,Status')).toBeNull();
    expect(screen.queryByText('CSV Preview')).toBeNull();
    expect(screen.getByRole('button', { name: '复制 CSV' })).toBeInTheDocument();
  });

  it('keeps non-csv fenced code blocks as regular preformatted code', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        '```ts',
        'const answer = 42;',
        '```',
      ].join('\n'),
    };

    const { container } = render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.getByText('const answer = 42;')).toBeInTheDocument();
  });

  it('renders markdown pipe tables as structured table preview', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        'Week 4: 优化与复盘',
        '',
        '| Task | Week | Owner | Status |',
        '| --- | --- | --- | --- |',
        '| 对比新旧结构CPA/CVR/CTR | Week 4 | 分析负责人 | 未开始 |',
        '| 对比高价值转化占比变化 | Week 4 | 分析负责人 | 未开始 |',
      ].join('\n'),
    };

    render(<ChatMessage message={message} showThinking={false} />);

    expect(screen.getByText('Week 4: 优化与复盘')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByText('对比新旧结构CPA/CVR/CTR')).toBeInTheDocument();
    expect(screen.queryByText('| Task | Week | Owner | Status |')).toBeNull();
    expect(screen.queryByText('Table Preview')).toBeNull();
  });
>>>>>>> theirs
>>>>>>> theirs
});
