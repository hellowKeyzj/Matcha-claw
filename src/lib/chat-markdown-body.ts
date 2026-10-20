import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionAssistantTurnItem, SessionTimelineAssistantTurnEntry } from '../types/session/render-item';
import {
  buildMarkdownCacheKey,
  getOrPrepareMarkdownBody,
  renderStreamingMarkdownBody,
  peekRenderedMarkdownBody,
  type MarkdownBodyRenderResult,
} from '@/pages/Chat/md-pipeline';
import {
  createFileHintPathResolver,
  linkifyFileHintsInMarkdown,
  migrateLegacyMarkdownFileLinks,
} from '@/pages/Chat/md-link';

type AssistantMarkdownSource = Pick<
  SessionTimelineAssistantTurnEntry,
  'key' | 'entryId' | 'messageId' | 'role' | 'createdAt' | 'text'
> & { attachedFiles?: ReadonlyArray<unknown> } | Pick<
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

function prepareAssistantMarkdown(source: AssistantMarkdownSource): string {
  const resolveFileHintPath = createFileHintPathResolver(getAssistantMarkdownSourceAttachedFiles(source));
  return linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(source.text, resolveFileHintPath),
    resolveFileHintPath,
  );
}

export function peekAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(source));
}

export function prewarmAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  return getOrBuildAssistantMarkdownBody(source);
}

export function prewarmAssistantMarkdownBodies(entries: SessionTimelineAssistantTurnEntry[]): void {
  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(entry);
  }
}

export function getOrBuildAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  const cacheKey = buildAssistantMarkdownCacheKey(source);
  return getOrPrepareMarkdownBody(cacheKey, () => prepareAssistantMarkdown(source));
}

export function renderStreamingAssistantMarkdownBody(source: AssistantMarkdownSource): MarkdownBodyRenderResult | undefined {
  const markdown = prepareAssistantMarkdown(source);
  return markdown.trim() ? renderStreamingMarkdownBody(markdown) : undefined;
}
