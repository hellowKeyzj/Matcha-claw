import { beforeEach, describe, expect, it } from 'vitest';
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
import { getOrBuildAssistantMarkdownBody, peekAssistantMarkdownBody, prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
} from '@/pages/Chat/md-pipeline';
import type { SessionTimelineEntry } from '../../src/types/session/render-item';

describe('chat markdown pipeline cache', () => {
  beforeEach(() => {
    clearUiTelemetry();
  });

  it('prewarm 后再次读取不应重新触发 markdown 重算', () => {
    const markdown = Array.from(
      { length: 120 },
      (_, index) => `line-${index}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
    ).join('\n\n');
    const cacheKey = buildMarkdownCacheKey({
      messageId: 'assistant-1',
      role: 'assistant',
      timestamp: 1_700_000_000,
      text: markdown,
      attachedFiles: [],
    });

    prewarmMarkdownBody(cacheKey, {
      markdown,
    });

    expect(peekRenderedMarkdownBody(cacheKey)).toBeDefined();

    clearUiTelemetry();

    const renderResult = getOrBuildMarkdownBody(cacheKey, {
      markdown,
    });

    expect(renderResult.fullHtml).toContain('https://openai.com');
    expect(
      getUiTelemetrySnapshot().filter((entry) => entry.event === 'chat.md_process_cost'),
    ).toHaveLength(0);
  });

  it('assistant markdown cache 命中时，peek 不应再做 markdown 预处理与重算', () => {
    const entry: SessionTimelineEntry = {
      entryId: 'assistant-cache-hit',
      key: 'assistant-cache-hit',
      sessionKey: 'agent:main:test',
      laneKey: 'main',
      turnKey: 'main:assistant-cache-hit',
      role: 'assistant',
      kind: 'message',
      status: 'final',
      createdAt: 1_700_000_100,
      text: '[TOOLS.md](TOOLS.md)',
      thinking: null,
      assistantSegments: [],
      images: [],
      toolUses: [],
      attachedFiles: [{
        fileName: 'TOOLS.md',
        mimeType: 'text/markdown',
        fileSize: 1024,
        preview: null,
        filePath: 'C:/workspace/TOOLS.md',
      }],
      toolCards: [],
      isStreaming: false,
      messageId: 'assistant-cache-hit',
      message: {
        id: 'assistant-cache-hit',
        role: 'assistant',
        timestamp: 1_700_000_100,
        content: '[TOOLS.md](TOOLS.md)',
        _attachedFiles: [{
          fileName: 'TOOLS.md',
          mimeType: 'text/markdown',
          fileSize: 1024,
          preview: null,
          filePath: 'C:/workspace/TOOLS.md',
        }],
      },
    };

    prewarmAssistantMarkdownBody(entry);

    clearUiTelemetry();

    const cached = peekAssistantMarkdownBody(entry)
      ?? getOrBuildAssistantMarkdownBody(entry);

    expect(cached?.fullHtml).toContain('matchaclaw.local');
    expect(
      getUiTelemetrySnapshot().filter((entry) => entry.event === 'chat.md_process_cost'),
    ).toHaveLength(0);
  });
});

describe('chat markdown pipeline fenced code', () => {
  it('renders fenced code with copy affordance and escapes code and language', () => {
    const result = getOrBuildMarkdownBody('code:fence-html-escaping', {
      markdown: [
        '```ts" onclick="alert(1)',
        '<script>alert("x")</script>',
        '```',
      ].join('\n'),
    });

    expect(result.fullHtml).toContain('<figure class="chat-code-block" data-chat-code-block>');
    expect(result.fullHtml).toContain('<figcaption class="chat-code-header">');
    expect(result.fullHtml).toContain('<span class="chat-code-language">ts&quot;</span>');
    expect(result.fullHtml).toContain('<button type="button" class="chat-code-copy" data-chat-code-copy aria-label="Copy code">');
    expect(result.fullHtml).toContain('<span class="chat-code-copy-default">Copy</span>');
    expect(result.fullHtml).toContain('<span class="chat-code-copy-done" hidden>Copied</span>');
    expect(result.fullHtml).toContain('<pre><code class="language-ts&quot;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n</code></pre>');
    expect(result.fullHtml).not.toContain('<script>');
    expect(result.fullHtml).not.toContain('onclick="alert(1)');
  });
});

describe('chat markdown pipeline math rendering', () => {
  it('renders inline and block LaTeX delimiters with KaTeX', () => {
    const result = getOrBuildMarkdownBody('math:basic', {
      markdown: [
        'Mass-energy: $E=mc^2$',
        '',
        '\\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\)',
        '',
        '$$',
        '\\int_0^1 x\\,dx = \\frac{1}{2}',
        '$$',
        '',
        '\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]',
      ].join('\n'),
    });

    expect(result.fullHtml).toContain('class="katex"');
    expect(result.fullHtml).toContain('class="katex-display"');
  });

  it('does not parse LaTeX delimiters inside code fences or inline code', () => {
    const result = getOrBuildMarkdownBody('math:code', {
      markdown: [
        'Inline code: `\\(hello\\)`',
        '',
        '```ts',
        'console.log("\\[still code\\]");',
        '```',
      ].join('\n'),
    });

    expect(result.fullHtml).toContain('\\(hello\\)');
    expect(result.fullHtml).toContain('\\[still code\\]');
    expect(result.fullHtml).not.toContain('class="katex"');
  });
});
