import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionMessageRow } from '../../runtime-host/shared/session-adapter-types';
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

export function getMessageRowAttachedFiles(row: SessionMessageRow): AttachedFileMeta[] {
  return Array.isArray(row.attachedFiles)
    ? row.attachedFiles as unknown as AttachedFileMeta[]
    : [];
}

export function buildAssistantMarkdownCacheKey(row: SessionMessageRow): string {
  return buildMarkdownCacheKey({
    messageId: row.messageId ?? row.entryId ?? row.key,
    role: row.role,
    timestamp: row.createdAt,
    text: row.text,
    attachedFiles: getMessageRowAttachedFiles(row),
  });
}

function buildAssistantMarkdownBodyInput(row: SessionMessageRow): PreparedAssistantMarkdownBodyInput {
  const attachedFiles = getMessageRowAttachedFiles(row);
  const resolveFileHintPath = createFileHintPathResolver(attachedFiles);
  const markdown = linkifyFileHintsInMarkdown(
    migrateLegacyMarkdownFileLinks(row.text, resolveFileHintPath),
    resolveFileHintPath,
  );
  return {
    cacheKey: buildAssistantMarkdownCacheKey(row),
    markdown,
  };
}

export function peekAssistantMarkdownBody(row: SessionMessageRow): MarkdownBodyRenderResult | undefined {
  return peekRenderedMarkdownBody(buildAssistantMarkdownCacheKey(row));
}

export function prewarmAssistantMarkdownBody(row: SessionMessageRow): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(row);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(row);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return prewarmMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}

export function prewarmAssistantMarkdownBodies(rows: SessionMessageRow[]): void {
  for (const row of rows) {
    if (row.role !== 'assistant') {
      continue;
    }
    prewarmAssistantMarkdownBody(row);
  }
}

export function getOrBuildAssistantMarkdownBody(row: SessionMessageRow): MarkdownBodyRenderResult | undefined {
  const cached = peekAssistantMarkdownBody(row);
  if (cached) {
    return cached;
  }
  const input = buildAssistantMarkdownBodyInput(row);
  if (!input.markdown.trim()) {
    return undefined;
  }
  return getOrBuildMarkdownBody(input.cacheKey, {
    markdown: input.markdown,
  });
}
