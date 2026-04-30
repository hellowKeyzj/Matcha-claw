import type { AttachedFileMeta, RawMessage } from '@/stores/chat';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
  type MarkdownBodyRenderResult,
} from '@/pages/Chat/md-pipeline';
import { extractText } from '@/pages/Chat/message-utils';
import {
  createFileHintPathResolver,
  linkifyFileHintsInMarkdown,
  migrateLegacyMarkdownFileLinks,
} from '@/pages/Chat/md-link';

interface PreparedAssistantMarkdownBodyInput {
  cacheKey: string;
  markdown: string;
}

export function getMessageAttachedFiles(message: RawMessage): AttachedFileMeta[] {
  return Array.isArray(message._attachedFiles) ? message._attachedFiles : [];
}

export function buildAssistantMarkdownCacheKey(
  message: RawMessage,
): string {
  const text = extractText(message);
  const attachedFiles = getMessageAttachedFiles(message);
  const baseCacheKey = buildMarkdownCacheKey({
    messageId: typeof message.id === 'string' ? message.id : undefined,
    role: typeof message.role === 'string' ? message.role : undefined,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
    text,
    attachedFiles,
  });
  return baseCacheKey;
}

function buildAssistantMarkdownBodyInput(
  message: RawMessage,
): PreparedAssistantMarkdownBodyInput {
  const text = extractText(message);
  const attachedFiles = getMessageAttachedFiles(message);
  const resolveFileHintPath = createFileHintPathResolver(attachedFiles);
  const markdown = linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(text, resolveFileHintPath),
    resolveFileHintPath,
  );

  return {
    cacheKey: buildAssistantMarkdownCacheKey(message),
    markdown,
  };
}

export function peekAssistantMarkdownBody(
  message: RawMessage,
): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(message));
}

export function prewarmAssistantMarkdownBody(
  message: RawMessage,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(message);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(message);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return prewarmMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}

export function prewarmAssistantMarkdownBodies(
  messages: RawMessage[],
): void {
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(message);
  }
}

export function getOrBuildAssistantMarkdownBody(
  message: RawMessage,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(message);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(message);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return getOrBuildMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}
