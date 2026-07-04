import type { ChatRenderItem } from './chat-render-item-model';
import type {
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
} from '../../../runtime-host/shared/session-adapter-types';

export interface ChatSessionMarkdownExportInput {
  title?: string | null;
  sessionKey: string;
  agentName?: string | null;
  items: ReadonlyArray<ChatRenderItem>;
  exportedAt: Date;
}

export interface ChatSessionMarkdownExport {
  fileName: string;
  markdown: string;
}

const MARKDOWN_DOWNLOAD_MIME_TYPE = 'text/markdown;charset=utf-8';

function normalizeMarkdownTitle(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() || 'Chat Session';
}

function formatExportTimestamp(exportedAt: Date): string {
  const time = exportedAt.getTime();
  if (!Number.isFinite(time)) {
    return '';
  }
  return exportedAt.toISOString();
}

function formatTimestampForFile(exportedAt: Date): string {
  const timestamp = formatExportTimestamp(exportedAt);
  if (!timestamp) {
    return '';
  }
  return timestamp.slice(0, 19).replace(/[T:]/g, '-');
}

export function sanitizeMarkdownDownloadFileName(fileName: string): string {
  const sanitizedBaseName = fileName
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.md$/i, '')
    .replace(/[.\s-]+$/g, '') || 'chat-session';
  return `${sanitizedBaseName}.md`;
}

function appendText(lines: string[], text: string | null | undefined): boolean {
  const normalized = text?.trim();
  if (!normalized) {
    return false;
  }
  lines.push(normalized);
  return true;
}

function formatFileSize(fileSize: number | undefined): string {
  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
    return '';
  }
  if (fileSize < 1024) {
    return `${fileSize} B`;
  }
  const kib = fileSize / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function appendAttachedFiles(lines: string[], attachedFiles: ReadonlyArray<SessionRenderAttachedFile>): boolean {
  if (attachedFiles.length === 0) {
    return false;
  }
  lines.push('Attachments:');
  for (const file of attachedFiles) {
    const size = formatFileSize(file.fileSize);
    const suffix = [file.mimeType, size].filter(Boolean).join(', ');
    lines.push(`- ${file.fileName}${suffix ? ` (${suffix})` : ''}`);
  }
  return true;
}

function appendImages(lines: string[], images: ReadonlyArray<SessionRenderImage>): boolean {
  if (images.length === 0) {
    return false;
  }
  lines.push('Images:');
  for (const image of images) {
    lines.push(`- ${image.mimeType}`);
  }
  return true;
}

function markdownFenceFor(text: string): string {
  const matches = text.match(/`{3,}/g) ?? [];
  const longest = matches.reduce((max, fence) => Math.max(max, fence.length), 2);
  return '`'.repeat(longest + 1);
}

function appendFencedBlock(lines: string[], language: string, body: string): void {
  const fence = markdownFenceFor(body);
  lines.push(`${fence}${language}`, body, fence);
}

function serializeToolInput(tool: SessionRenderToolCard): string | null {
  const inputText = tool.inputText?.trim();
  if (inputText) {
    return inputText;
  }
  const input = tool.input;
  if (input == null) {
    return null;
  }
  if (typeof input === 'string') {
    return input.trim() || null;
  }
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return Object.prototype.toString.call(input);
  }
}

function isJsonText(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function appendToolInput(lines: string[], tool: SessionRenderToolCard): boolean {
  const inputText = serializeToolInput(tool);
  if (!inputText) {
    return false;
  }
  lines.push('Input:');
  appendFencedBlock(lines, isJsonText(inputText) ? 'json' : '', inputText);
  return true;
}

function appendToolResult(lines: string[], tool: SessionRenderToolCard): boolean {
  const result = tool.result;
  if (result.kind === 'text') {
    lines.push('Output:');
    appendFencedBlock(lines, '', result.bodyText);
    return true;
  }
  if (result.kind === 'json') {
    lines.push('Output:');
    appendFencedBlock(lines, 'json', result.bodyText);
    return true;
  }
  if (result.kind === 'canvas' && result.rawText?.trim()) {
    lines.push('Output:');
    appendFencedBlock(lines, isJsonText(result.rawText) ? 'json' : '', result.rawText.trim());
    return true;
  }
  return false;
}

function renderToolCardMarkdown(tool: SessionRenderToolCard): string[] {
  const title = tool.displayTitle?.trim() || tool.name?.trim() || 'Tool';
  const lines = [`### Tool: ${title}`];
  const status = tool.status?.trim();
  const detail = tool.displayDetail?.trim();
  const summary = tool.summary?.trim();
  if (status) {
    lines.push(`- Status: ${status}`);
  }
  if (detail) {
    lines.push(`- Input summary: ${detail}`);
  }
  if (summary) {
    lines.push(`- Summary: ${summary}`);
  }
  const inputLines: string[] = [];
  const outputLines: string[] = [];
  if (appendToolInput(inputLines, tool)) {
    lines.push('', ...inputLines);
  }
  if (appendToolResult(outputLines, tool)) {
    lines.push('', ...outputLines);
  }
  return lines;
}

function renderUserItemMarkdown(item: Extract<ChatRenderItem, { kind: 'user-message' }>): string[] {
  const contentLines: string[] = [];
  const hasText = appendText(contentLines, item.text);
  const mediaLines: string[] = [];
  const hasImages = appendImages(mediaLines, item.images);
  const hasAttachedFiles = appendAttachedFiles(mediaLines, item.attachedFiles);
  return [
    '## User',
    '',
    ...(hasText ? contentLines : []),
    ...(hasText && (hasImages || hasAttachedFiles) ? [''] : []),
    ...(hasImages || hasAttachedFiles ? mediaLines : []),
    ...(!hasText && !hasImages && !hasAttachedFiles ? ['(empty)'] : []),
  ];
}

function renderAssistantItemMarkdown(item: Extract<ChatRenderItem, { kind: 'assistant-turn' }>): string[] {
  const agentName = item.assistantPresentation?.agentName?.trim();
  const contentLines: string[] = [];
  for (const segment of item.segments) {
    if (segment.kind === 'message') {
      appendText(contentLines, segment.text);
      continue;
    }
    if (segment.kind === 'media') {
      const mediaLines: string[] = [];
      const hasImages = appendImages(mediaLines, segment.images);
      const hasAttachedFiles = appendAttachedFiles(mediaLines, segment.attachedFiles);
      if (hasImages || hasAttachedFiles) {
        if (contentLines.length > 0) {
          contentLines.push('');
        }
        contentLines.push(...mediaLines);
      }
      continue;
    }
    if (segment.kind === 'tool') {
      if (contentLines.length > 0) {
        contentLines.push('');
      }
      contentLines.push(...renderToolCardMarkdown(segment.tool));
    }
  }

  return [
    agentName ? `## Assistant · ${agentName}` : '## Assistant',
    '',
    ...(contentLines.length > 0 ? contentLines : ['(empty)']),
  ];
}

function renderSystemItemMarkdown(item: Extract<ChatRenderItem, { kind: 'system' }>): string[] {
  const contentLines: string[] = [];
  appendText(contentLines, item.text);
  return [
    `## System · ${item.level}`,
    '',
    ...(contentLines.length > 0 ? contentLines : ['(empty)']),
  ];
}

function renderChatItemMarkdown(item: ChatRenderItem): string[] | null {
  if (item.kind === 'user-message') {
    return renderUserItemMarkdown(item);
  }
  if (item.kind === 'assistant-turn') {
    return renderAssistantItemMarkdown(item);
  }
  if (item.kind === 'system') {
    return renderSystemItemMarkdown(item);
  }
  return null;
}

export function buildChatSessionMarkdownExport(input: ChatSessionMarkdownExportInput): ChatSessionMarkdownExport {
  const title = normalizeMarkdownTitle(input.title);
  const exportedAt = formatExportTimestamp(input.exportedAt);
  const fileTimestamp = formatTimestampForFile(input.exportedAt);
  const fileName = sanitizeMarkdownDownloadFileName(fileTimestamp ? `${title}-${fileTimestamp}` : title);
  const itemSections = input.items.flatMap((item) => {
    const section = renderChatItemMarkdown(item);
    return section ? [section] : [];
  });
  const lines = [
    `# ${title}`,
    '',
    `- Session: ${input.sessionKey}`,
    ...(input.agentName?.trim() ? [`- Agent: ${input.agentName.trim()}`] : []),
    ...(exportedAt ? [`- Exported: ${exportedAt}`] : []),
    `- Messages: ${itemSections.length}`,
  ];

  if (itemSections.length === 0) {
    lines.push('', '(empty)');
  } else {
    for (const section of itemSections) {
      lines.push('', ...section);
    }
  }

  return {
    fileName,
    markdown: `${lines.join('\n').trimEnd()}\n`,
  };
}

export function downloadMarkdownFile(fileName: string, markdown: string): void {
  const blob = new Blob([markdown], { type: MARKDOWN_DOWNLOAD_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeMarkdownDownloadFileName(fileName);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
