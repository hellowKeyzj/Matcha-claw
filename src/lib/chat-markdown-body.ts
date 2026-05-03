import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
  type MarkdownBodyRenderResult,
} from '@/pages/Chat/md-pipeline';
import { extractEntryText } from '@/pages/Chat/message-utils';
import {
  createFileHintPathResolver,
  linkifyFileHintsInMarkdown,
  migrateLegacyMarkdownFileLinks,
} from '@/pages/Chat/md-link';

interface PreparedAssistantMarkdownBodyInput {
  cacheKey: string;
  markdown: string;
}

export function getTimelineEntryAttachedFiles(entry: SessionTimelineEntry): AttachedFileMeta[] {
  return Array.isArray(entry.message._attachedFiles)
    ? entry.message._attachedFiles as unknown as AttachedFileMeta[]
    : [];
}

export function buildAssistantMarkdownCacheKey(
  entry: SessionTimelineEntry,
): string {
  const text = extractEntryText(entry);
  const attachedFiles = getTimelineEntryAttachedFiles(entry);
  const baseCacheKey = buildMarkdownCacheKey({
    messageId: entry.entryId,
    role: entry.role,
    timestamp: entry.timestamp,
    text,
    attachedFiles,
  });
  return baseCacheKey;
}

function buildAssistantMarkdownBodyInput(
  entry: SessionTimelineEntry,
): PreparedAssistantMarkdownBodyInput {
  const text = extractEntryText(entry);
  const attachedFiles = getTimelineEntryAttachedFiles(entry);
  const resolveFileHintPath = createFileHintPathResolver(attachedFiles);
  const markdown = linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(text, resolveFileHintPath),
    resolveFileHintPath,
  );

  return {
    cacheKey: buildAssistantMarkdownCacheKey(entry),
    markdown,
  };
}

export function peekAssistantMarkdownBody(
  entry: SessionTimelineEntry,
): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(entry));
}

export function prewarmAssistantMarkdownBody(
  entry: SessionTimelineEntry,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(entry);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(entry);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return prewarmMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}

export function prewarmAssistantMarkdownBodies(
  entries: SessionTimelineEntry[],
): void {
  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(entry);
  }
}

export function getOrBuildAssistantMarkdownBody(
  entry: SessionTimelineEntry,
): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(entry);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(entry);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return getOrBuildMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}
