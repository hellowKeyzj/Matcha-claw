import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import type { ChatAssistantTurnItem } from '@/plugins/message-rendering/chat-render-item-model';
import { createAttachedMediaMatcher } from '@/plugins/message-rendering/md-link';
import type { ToolSlot } from '@/plugins/message-rendering/tool-groups';
import type { SessionAssistantTurnSegment } from '@/types/session/tool-card';
import { isCoveredToolOnlyItem } from './tool-group-plan';

type MarkdownFenceState = { marker: '`' | '~'; length: number } | null;

function readFenceMarker(line: string): { marker: '`' | '~'; length: number; closingOnly: boolean } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1] ?? '';
  const rest = match[2] ?? '';
  return { marker: fence[0] === '~' ? '~' : '`', length: fence.length, closingOnly: rest.trim().length === 0 };
}

function advanceMarkdownFenceState(text: string, initialState: MarkdownFenceState): MarkdownFenceState {
  let state = initialState;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const fence = readFenceMarker(line);
    if (!fence) continue;
    if (state) {
      if (fence.marker === state.marker && fence.length >= state.length && fence.closingOnly) state = null;
    } else {
      state = { marker: fence.marker, length: fence.length };
    }
  }
  return state;
}

function removeLeadingFenceClose(text: string, state: MarkdownFenceState): string {
  if (!state) return text;
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return text;
  const fence = match[1] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  return marker === state.marker && fence.length >= state.length ? text.slice(match[0].length) : text;
}

export function buildAssistantTurnView(
  item: ChatAssistantTurnItem,
  showThinking: boolean,
  formatText: (text: string) => string,
  toolSlots?: ReadonlyMap<string, ToolSlot>,
) {
  const seen = new Set<string>();
  const attachedFiles: AttachedFileMeta[] = [];
  const mediaSegments = item.segments.map((segment) => {
    if (segment.kind !== 'media') return segment;
    const files = segment.attachedFiles.filter((file) => {
      const refs = [file.resourceId, file.filePath, file.gatewayUrl, file.mediaReference].filter((ref): ref is string => !!ref);
      const duplicate = refs.some((ref) => seen.has(ref));
      for (const ref of refs) seen.add(ref);
      if (!duplicate) attachedFiles.push(file);
      return !duplicate;
    });
    return { ...segment, attachedFiles: files };
  });
  const attached = createAttachedMediaMatcher(attachedFiles);
  const segments: SessionAssistantTurnSegment[] = [];
  const messageRenderTextByKey = new Map<string, string>();
  let fenceState: MarkdownFenceState = null;
  for (const segment of mediaSegments) {
    switch (segment.kind) {
      case 'message': {
        const text = formatText(removeLeadingFenceClose(segment.text, fenceState));
        messageRenderTextByKey.set(segment.key, text);
        fenceState = advanceMarkdownFenceState(segment.text, fenceState);
        if (segment.largeText || text.trim()) segments.push({ ...segment, text });
        break;
      }
      case 'thinking':
        if (showThinking && segment.text.trim()) segments.push(segment);
        break;
      case 'tool':
        if (segment.tool.result.kind === 'canvas' && segment.tool.result.surface === 'assistant-bubble'
          || toolSlots?.get(segment.key)?.kind === 'head') segments.push(segment);
        break;
      case 'media': {
        const images = segment.images.filter((image) => {
          const source = image.url || (image.data ? `data:${image.mimeType};base64,${image.data}` : '');
          if (!source || attached(source) || seen.has(source)) return false;
          seen.add(source);
          return true;
        });
        if (images.length || segment.attachedFiles.length || segment.contentNotices?.length) segments.push({ ...segment, images });
        break;
      }
    }
  }
  const active = item.status === 'streaming' || item.status === 'waiting_tool';
  const pendingMode = !segments.length && !isCoveredToolOnlyItem(item, toolSlots) && active
    ? (item.pendingState ?? (item.status === 'waiting_tool' ? 'activity' : 'typing')) : null;
  return { segments, attachedFiles, messageRenderTextByKey, pendingMode,
    plainText: formatText(item.text.trim()), visible: segments.length > 0 || !!pendingMode };
}
