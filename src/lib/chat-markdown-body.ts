import type { AttachedFileMeta, RawMessage } from '@/stores/chat';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
  type MarkdownBodyRenderResult,
  type MarkdownRenderMode,
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
  mode: MarkdownRenderMode,
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
  return `${baseCacheKey}|${mode}`;
}

function buildAssistantMarkdownBodyInput(
  message: RawMessage,
  mode: MarkdownRenderMode,
): PreparedAssistantMarkdownBodyInput {
  const text = extractText(message);
  const attachedFiles = getMessageAttachedFiles(message);
  const resolveFileHintPath = createFileHintPathResolver(attachedFiles);
  const markdown = linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(text, resolveFileHintPath),
    resolveFileHintPath,
  );

  return {
    cacheKey: buildAssistantMarkdownCacheKey(message, mode),
    markdown,
  };
}

export function peekAssistantMarkdownBody(
  message: RawMessage,
  mode: MarkdownRenderMode,
): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(message, mode));
}

export function prewarmAssistantMarkdownBody(
  message: RawMessage,
  mode: MarkdownRenderMode,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(message, mode);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(message, mode);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return prewarmMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
    mode,
  });
}

export function prewarmAssistantMarkdownBodies(
  messages: RawMessage[],
  mode: MarkdownRenderMode,
): void {
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(message, mode);
  }
}

export function getOrBuildAssistantMarkdownBody(
  message: RawMessage,
  mode: MarkdownRenderMode,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(message, mode);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(message, mode);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return getOrBuildMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
    mode,
  });
}
