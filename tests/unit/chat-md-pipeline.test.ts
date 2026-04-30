import { beforeEach, describe, expect, it } from 'vitest';
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
import { getOrBuildAssistantMarkdownBody, peekAssistantMarkdownBody, prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
} from '@/pages/Chat/md-pipeline';
import type { RawMessage } from '@/stores/chat';

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
    const message: RawMessage = {
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
    };

    prewarmAssistantMarkdownBody(message);

    clearUiTelemetry();

    const cached = peekAssistantMarkdownBody(message)
      ?? getOrBuildAssistantMarkdownBody(message);

    expect(cached?.fullHtml).toContain('matchaclaw.local');
    expect(
      getUiTelemetrySnapshot().filter((entry) => entry.event === 'chat.md_process_cost'),
    ).toHaveLength(0);
  });
});
