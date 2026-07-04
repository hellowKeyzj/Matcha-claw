import { describe, expect, it, vi } from 'vitest';
import {
  buildChatSessionMarkdownExport,
  downloadMarkdownFile,
  sanitizeMarkdownDownloadFileName,
} from '@/pages/Chat/session-markdown-export';
import type { ChatRenderItem } from '@/pages/Chat/chat-render-item-model';

function buildExportItems(): ChatRenderItem[] {
  return [
    {
      key: 'user-1',
      kind: 'user-message',
      role: 'user',
      sessionKey: 'session-1',
      text: 'Hello **Matcha**',
      images: [{ mimeType: 'image/png' }],
      attachedFiles: [{
        fileName: 'brief.txt',
        mimeType: 'text/plain',
        fileSize: 42,
        preview: null,
      }],
      renderSignature: 'user-1',
      assistantPresentation: null,
    },
    {
      key: 'assistant-1',
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey: 'session-1',
      identitySource: 'run',
      identityMode: 'run',
      identityConfidence: 'strong',
      status: 'final',
      segments: [
        { kind: 'message', key: 'message-1', text: 'Reply text' },
        {
          kind: 'tool',
          key: 'tool-1',
          tool: {
            id: 'tool-1',
            name: 'read_file',
            displayTitle: 'Read file',
            displayDetail: 'README.md',
            input: {
              runId: 'teamrun-1',
              runtimeKind: 'native-runtime',
              runtimeAdapterId: 'openclaw',
              result: {
                kind: 'review',
                summary: 'Business model analysis passed',
              },
            },
            inputText: '{\n  "runId": "teamrun-1",\n  "runtimeKind": "native-runtime",\n  "runtimeAdapterId": "openclaw",\n  "result": {\n    "kind": "review",\n    "summary": "Business model analysis passed"\n  }\n}',
            status: 'completed',
            summary: 'Read succeeded',
            result: {
              kind: 'text',
              surface: 'tool-card',
              collapsedPreview: 'File content',
              bodyText: 'File content\n```\ninner fence\n```',
            },
          },
        },
      ],
      thinking: null,
      tools: [],
      text: 'Reply text',
      images: [],
      attachedFiles: [],
      renderSignature: 'assistant-1',
      assistantPresentation: {
        agentId: 'agent-1',
        agentName: 'Main Agent',
      },
    },
  ];
}

describe('chat session markdown export', () => {
  it('serializes visible chat items into a markdown transcript', () => {
    const exported = buildChatSessionMarkdownExport({
      title: 'Unsafe: Session',
      sessionKey: 'session-1',
      agentName: 'Main Agent',
      items: buildExportItems(),
      exportedAt: new Date('2026-07-02T12:34:56.000Z'),
    });

    expect(exported.fileName).toBe('Unsafe- Session-2026-07-02-12-34-56.md');
    expect(exported.markdown).toContain('# Unsafe: Session');
    expect(exported.markdown).toContain('- Session: session-1');
    expect(exported.markdown).toContain('- Agent: Main Agent');
    expect(exported.markdown).toContain('## User');
    expect(exported.markdown).toContain('Hello **Matcha**');
    expect(exported.markdown).toContain('- brief.txt (text/plain, 42 B)');
    expect(exported.markdown).toContain('## Assistant · Main Agent');
    expect(exported.markdown).toContain('### Tool: Read file');
    expect(exported.markdown).toContain('- Status: completed');
    expect(exported.markdown).toContain('- Input summary: README.md');
    expect(exported.markdown).toContain('Input:\n```json\n{\n  "runId": "teamrun-1",');
    expect(exported.markdown).toContain('"summary": "Business model analysis passed"');
    expect(exported.markdown).toContain('Output:\n````\nFile content\n```\ninner fence\n```\n````');
  });

  it('sanitizes markdown file names', () => {
    expect(sanitizeMarkdownDownloadFileName('../bad:name.md')).toBe('-bad-name.md');
    expect(sanitizeMarkdownDownloadFileName('')).toBe('chat-session.md');
  });

  it('downloads markdown through a blob URL', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:chat-markdown');
    const revokeObjectURL = vi.fn();
    const clickedAnchors: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function recordClickedAnchor(this: HTMLAnchorElement) {
      clickedAnchors.push(this);
    });
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    try {
      downloadMarkdownFile('Unsafe: Session.md', '# transcript\n');

      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      const downloadedBlob = createObjectURL.mock.calls[0]?.[0];
      await expect((downloadedBlob as Blob).text()).resolves.toBe('# transcript\n');
      expect(clickedAnchors).toHaveLength(1);
      expect(clickedAnchors[0]?.download).toBe('Unsafe- Session.md');
      expect(clickedAnchors[0]?.href).toBe('blob:chat-markdown');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:chat-markdown');
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true });
    }
  });
});
