import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
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

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('TOOLS.md')[0];
    fireEvent.click(linkText);

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

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const linkText = screen.getAllByText('TOOLS.md')[0];
    fireEvent.click(linkText);

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', targetPath);
  });

  it('legacy markdown relative file link should not be clickable without attached absolute path', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[TOOLS.md](TOOLS.md)',
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

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

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    expect(screen.queryByRole('button', { name: otherPath })).toBeNull();
    expect(screen.queryByRole('link', { name: otherPath })).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('http links should remain external links', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

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

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

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
    const message: RawMessage = {
      role: 'assistant',
      content: '[OpenAI](https://openai.com)',
    };

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

});
