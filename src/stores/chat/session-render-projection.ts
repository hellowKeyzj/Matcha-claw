import type { SessionAssistantTurnItem, SessionRenderItem } from '../../types/session/render-item';
import type { SessionAssistantTurnSegment, SessionRenderAttachedFile, SessionRenderImage, SessionRenderToolCard } from '../../types/session/tool-card';
import type { SessionWireContent, SessionWireItem, SessionWireRuntime, SessionWireTool } from '../../types/session/snapshot';
import { getSessionTextModel } from './session-presentation';
import { projectSessionMedia } from './media-projection';
import { adoptSessionProjectionFact, isSessionProjectionFact, stringifySessionToolPayload } from './session-projection-facts';
import { factValue, type SessionProjectionState } from './session-projection-state';

function projectionItemStatus(status: SessionWireItem['status']): SessionAssistantTurnItem['status'] {
  switch (status) {
    case 'pending':
    case 'streaming': return 'streaming';
    case 'waiting_for_tool': return 'waiting_tool';
    case 'final': return 'final';
    case 'error': return 'error';
    case 'aborted': return 'aborted';
  }
}

function projectionToolCard(
  tool: SessionWireTool,
  runtimeAdapterId: SessionRenderToolCard['runtimeAdapterId'],
  status: SessionRenderToolCard['status'],
  cache = false,
): SessionRenderToolCard {
  const summary = tool.summary ?? undefined;
  const input = tool.input ?? {};
  const inputText = tool.inputText ?? stringifySessionToolPayload(tool.input, cache);
  const outputText = typeof tool.output === 'string' ? tool.output : stringifySessionToolPayload(tool.output, cache) ?? summary;
  const resultKind = typeof tool.output === 'string' || tool.output === null ? 'text' : 'json';
  return {
    id: tool.toolCallId,
    toolCallId: tool.toolCallId,
    ...(tool.runId ? { runId: tool.runId } : {}),
    name: tool.name ?? 'tool',
    displayTitle: tool.name ?? 'tool',
    input,
    ...(inputText ? { inputText } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(runtimeAdapterId ? { runtimeAdapterId } : {}),
    ...(tool.output === null ? {} : { output: tool.output }),
    ...(tool.details == null ? {} : { details: tool.details }),
    result: outputText
      ? { kind: resultKind, surface: 'tool-card', collapsedPreview: summary ?? outputText, bodyText: outputText }
      : { kind: 'none', surface: 'tool-card' },
  };
}

function projectionMedia(content: SessionWireContent): { images: SessionRenderImage[]; attachedFiles: SessionRenderAttachedFile[] } {
  return projectSessionMedia(content);
}

function projectionLargeText(content: SessionWireContent) {
  return content.kind === 'largeText'
    ? { contentRef: content.contentRef, totalBytes: content.totalBytes, loadedBytes: content.loadedBytes }
    : undefined;
}

export interface SessionRenderProjectionCache {
  identityKey: string;
  sessionKey: string;
  tools: Map<string, { fact: SessionWireTool; status: SessionRenderToolCard['status']; card: SessionRenderToolCard }>;
  items: Map<string, { fact: SessionWireItem; tools: (SessionRenderToolCard | undefined)[]; item: SessionRenderItem }>;
}

const controlledItems = new WeakSet<SessionRenderItem>();
const controlledTools = new WeakSet<SessionRenderToolCard>();

export function isControlledSessionRenderItem(item: SessionRenderItem): boolean {
  return controlledItems.has(item);
}

export function isControlledSessionRenderTool(tool: SessionRenderToolCard): boolean {
  return controlledTools.has(tool);
}

/** Pure external projection: it never reads or populates a session/store cache. */
export function projectSessionViewItems(view: SessionProjectionState): SessionRenderItem[] {
  return projectItems(view);
}

export function projectControlledSessionViewItems(
  view: SessionProjectionState,
  caches: Map<string, SessionRenderProjectionCache>,
  key: string,
): SessionRenderItem[] {
  const identityKey = JSON.stringify(view.identity);
  let cache = caches.get(key);
  if (!cache || cache.identityKey !== identityKey || cache.sessionKey !== view.sessionKey) {
    cache = { identityKey, sessionKey: view.sessionKey, tools: new Map(), items: new Map() };
    caches.set(key, cache);
  }
  return projectItems(view, cache);
}

function projectItems(view: SessionProjectionState, cache?: SessionRenderProjectionCache): SessionRenderItem[] {
  const items = factValue(view.items);
  if (!items) {
    cache?.items.clear();
    cache?.tools.clear();
    return [];
  }
  const tools = factValue(view.tools) ?? [];
  const runtimeAdapterId = view.identity.endpoint.runtimeAdapterId;
  const text = getSessionTextModel(view.identity);
  const abortedRunIds = new Set<string>();
  const abortedToolIds = new Set<string>();
  const toolRunIds = new Map<string, string | null>();
  for (const item of items) {
    if (item.kind !== 'assistantTurn') continue;
    if (item.status === 'aborted' && item.runId) abortedRunIds.add(item.runId);
    for (const segment of item.segments) {
      if (segment.kind !== 'toolUse' && segment.kind !== 'toolResult') continue;
      if (item.status === 'aborted') abortedToolIds.add(segment.toolCallId);
      if (!item.runId) continue;
      const previous = toolRunIds.get(segment.toolCallId);
      toolRunIds.set(segment.toolCallId, previous === undefined || previous === item.runId ? item.runId : null);
    }
  }
  const runtime = factValue(view.runtime);
  const runtimeConfirmed = runtime !== null && runtime.issue === null
    && view.completeness !== 'unknown' && view.completeness !== 'unavailable'
    && !(typeof view.completeness === 'object' && view.completeness.incomplete.missing.includes('replay_cursor'));
  const statusForTool = (tool: SessionWireTool): SessionRenderToolCard['status'] => {
    if (tool.phase === 'completed') return 'completed';
    if (tool.phase === 'failed') return 'error';
    const runId = tool.runId ?? toolRunIds.get(tool.toolCallId);
    if (abortedToolIds.has(tool.toolCallId) || (runId && abortedRunIds.has(runId))) return 'cancelled';
    if (!runtimeConfirmed) return 'unknown';
    if (isTerminalRunPhase(runtime.phase) || runtime.activeRunId === null) return 'missing_result';
    if (!runId) return 'unknown';
    return runtime.activeRunId === runId ? 'running' : 'missing_result';
  };
  const nextTools = new Map<string, { fact: SessionWireTool; status: SessionRenderToolCard['status']; card: SessionRenderToolCard }>();
  const toolsById = new Map<string, SessionRenderToolCard>();
  for (const tool of tools) {
    const status = statusForTool(tool);
    const previous = cache?.tools.get(tool.toolCallId);
    let card = previous?.fact === tool && previous.status === status && isSessionProjectionFact(tool)
      ? previous.card : projectionToolCard(tool, runtimeAdapterId, status, !!cache);
    if (cache && isSessionProjectionFact(tool) && !controlledTools.has(card)) {
      card = adoptSessionProjectionFact(card);
      if (isSessionProjectionFact(card)) controlledTools.add(card);
    }
    nextTools.set(tool.toolCallId, { fact: tool, status, card });
    toolsById.set(tool.toolCallId, card);
  }
  const nextItems = new Map<string, { fact: SessionWireItem; tools: (SessionRenderToolCard | undefined)[]; item: SessionRenderItem }>();
  const result = items.map((item) => {
    if (!cache || !isSessionProjectionFact(item)) return projectItem(item);
    const referencedTools = item.kind === 'assistantTurn' ? item.segments.flatMap((segment) =>
      segment.kind === 'toolUse' || segment.kind === 'toolResult' ? [toolsById.get(segment.toolCallId)] : []) : [];
    const previous = cache.items.get(item.itemId);
    if (previous?.fact === item && isControlledSessionRenderItem(previous.item)
      && previous.tools.length === referencedTools.length
      && previous.tools.every((tool, index) => tool === referencedTools[index])) {
      nextItems.set(item.itemId, previous);
      return previous.item;
    }
    let rendered = projectItem(item);
    if (referencedTools.every((tool) => !tool || controlledTools.has(tool))) {
      rendered = adoptSessionProjectionFact(rendered);
      if (isSessionProjectionFact(rendered)) controlledItems.add(rendered);
    }
    nextItems.set(item.itemId, { fact: item, tools: referencedTools, item: rendered });
    return rendered;
  });
  if (cache) {
    cache.tools = nextTools;
    cache.items = nextItems;
  }
  return result;

  function projectItem(item: SessionWireItem): SessionRenderItem {
    if (item.kind === 'userMessage') {
      const media = item.content.flatMap((content) => projectionMedia(content));
      const largeText = item.content.map(projectionLargeText).find(Boolean);
      return {
        key: item.itemId,
        kind: 'user-message',
        role: 'user',
        sessionKey: view.sessionKey,
        text: text.user(largeText ? item.content.find((content) => content.kind === 'largeText')!.text : item.text),
        images: media.flatMap((entry) => entry.images),
        attachedFiles: media.flatMap((entry) => entry.attachedFiles),
        ...(largeText ? { largeText } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    }
    if (item.kind === 'system') {
      return {
        key: item.itemId,
        kind: 'system',
        role: 'system',
        sessionKey: view.sessionKey,
        text: item.text,
        level: item.status === 'error' ? 'error' : item.status === 'aborted' ? 'warning' : 'info',
      };
    }
    const segments: SessionAssistantTurnSegment[] = [];
    let messageIndex = 0;
    let thinkingIndex = 0;
    let mediaIndex = 0;
    for (const [index, content] of item.segments.entries()) {
      if (content.kind === 'text') {
        segments.push({ kind: 'message', key: `${item.itemId}:message:${messageIndex++}`, text: content.text });
      } else if (content.kind === 'largeText') {
        segments.push({
          kind: 'message',
          key: `${item.itemId}:message:${messageIndex++}`,
          text: content.text,
          largeText: { contentRef: content.contentRef, totalBytes: content.totalBytes, loadedBytes: content.loadedBytes },
        });
      } else if (content.kind === 'thinking') {
        segments.push({ kind: 'thinking', key: `${item.itemId}:thinking:${thinkingIndex++}`, text: content.text });
      } else if (content.kind === 'media' || content.kind === 'omitted') {
        const media = projectionMedia(content);
        if (media.images.length || media.attachedFiles.length) {
          segments.push({ kind: 'media', key: `${item.itemId}:media:${mediaIndex++}`, ...media });
        }
      } else if (content.kind === 'toolUse' || content.kind === 'toolResult') {
        const tool = toolsById.get(content.toolCallId);
        if (tool) {
          segments.push({ kind: 'tool', key: `${item.itemId}:tool:${content.toolCallId}:${index}`, tool });
        }
      }
    }
    const toolSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool');
    const tools = toolSegments.map((segment) => segment.tool);
    const thinkingSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking');
    const messageSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message');
    const mediaSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media');
    const assistantTurn: SessionAssistantTurnItem = {
      key: item.itemId,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey: view.sessionKey,
      identitySource: item.runId ? 'run' : 'message',
      identityMode: item.runId ? 'run' : 'message',
      identityConfidence: 'strong',
      status: projectionItemStatus(item.status),
      segments,
      thinking: thinkingSegments.length ? thinkingSegments.map((segment) => segment.text).join('\\n') : null,
      tools,
      text: messageSegments.length ? messageSegments.map((segment) => segment.text).join('') : item.text,
      images: mediaSegments.flatMap((segment) => segment.images),
      attachedFiles: mediaSegments.flatMap((segment) => segment.attachedFiles),
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    };
    return assistantTurn;
  }
}

function isTerminalRunPhase(phase: SessionWireRuntime['phase']): boolean {
  return phase === 'completed'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'interrupted';
}

