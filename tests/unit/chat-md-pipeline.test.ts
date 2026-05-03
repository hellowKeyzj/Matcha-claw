import { beforeEach, describe, expect, it } from 'vitest';
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
import { getOrBuildAssistantMarkdownBody, peekAssistantMarkdownBody, prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
} from '@/pages/Chat/md-pipeline';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

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
      sessionKey: 'agent:main:test',
      laneKey: 'main',
      turnKey: 'main:assistant-cache-hit',
      role: 'assistant',
      status: 'final',
      timestamp: 1_700_000_100,
      text: '[TOOLS.md](TOOLS.md)',
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
