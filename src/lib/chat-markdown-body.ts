import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionAssistantTurnItem, SessionTimelineMessageEntry } from '../../runtime-host/shared/session-adapter-types';
import {
  buildMarkdownCacheKey,
  getOrBuildMarkdownBody,
  peekRenderedMarkdownBody,
  prewarmMarkdownBody,
  type MarkdownBodyRenderResult,
} from '@/pages/Chat/md-pipeline';
import {
  createFileHintPathResolver,
  linkifyFileHintsInMarkdown,
  migrateLegacyMarkdownFileLinks,
} from '@/pages/Chat/md-link';

interface PreparedAssistantMarkdownBodyInput {
  cacheKey: string;
  markdown: string;
}

type AssistantMarkdownSource = Pick<
  SessionTimelineMessageEntry,
  'key' | 'entryId' | 'messageId' | 'role' | 'createdAt' | 'text' | 'attachedFiles'
> | Pick<
  SessionAssistantTurnItem,
  'key' | 'role' | 'createdAt' | 'text' | 'attachedFiles'
>;

export function getAssistantMarkdownSourceAttachedFiles(source: AssistantMarkdownSource): AttachedFileMeta[] {
  return Array.isArray(source.attachedFiles)
    ? source.attachedFiles as unknown as AttachedFileMeta[]
    : [];
}

export function buildAssistantMarkdownCacheKey(source: AssistantMarkdownSource): string {
  return buildMarkdownCacheKey({
    messageId: ('messageId' in source ? source.messageId : undefined) ?? ('entryId' in source ? source.entryId : undefined) ?? source.key,
    role: source.role,
    timestamp: source.createdAt,
    text: source.text,
    attachedFiles: getAssistantMarkdownSourceAttachedFiles(source),
  });
}

function buildAssistantMarkdownBodyInput(source: AssistantMarkdownSource): PreparedAssistantMarkdownBodyInput {
  const attachedFiles = getAssistantMarkdownSourceAttachedFiles(source);
  const resolveFileHintPath = createFileHintPathResolver(attachedFiles);
  const markdown = linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(source.text, resolveFileHintPath),
    resolveFileHintPath,
  );
  return {
    cacheKey: buildAssistantMarkdownCacheKey(source),
    markdown,
  };
}

export function peekAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(source));
}

export function prewarmAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(source);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(source);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return prewarmMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}

export function prewarmAssistantMarkdownBodies(entries: SessionTimelineMessageEntry[]): void {
  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(entry);
  }
}

export function getOrBuildAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(source);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(source);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return getOrBuildMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}
