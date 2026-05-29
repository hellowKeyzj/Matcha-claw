import type {
  SessionAssistantTurnSegment,
  SessionExecutionGraphStep,
  SessionRenderAttachedFile,
  SessionRenderExecutionGraphItem,
  SessionRenderImage,
  SessionRenderItem,
  SessionRenderToolCard,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionTimelineUserMessageEntry,
} from '../../../shared/session-adapter-types';
import {
  extractImagesAsAttachedFiles,
  extractImagesFromSingleBlock,
} from '../assistant-segment-media';
import { buildAssistantTurnEntry, buildAssistantTurnEntryKey } from '../assistant-turn-entry';
import { buildRenderItemsFromTimeline } from '../session-render-model';
import { resolveToolCardRenderState } from '../tool/tool-card-render-state';
import { extractToolResultOutputText } from '../tool/tool-card-content';
import { extractToolResultMediaAttachments } from '../tool-result-media';
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordCallId,
} from '../state-only-tools';
import type { CanonicalMessageState, CanonicalSessionState, CanonicalToolState } from './canonical-state';

type MediaBundle = {
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
};

export type CanonicalProjectionRenderItemKeyIndex = {
  messageItemKeyByCanonicalKey: Map<string, string>;
  toolItemKeyByCanonicalKey: Map<string, string>;
};

const MAX_EXECUTION_GRAPH_STEPS = 32;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row) {
      return [];
    }
    if ((row.type === 'text' || row.type === 'message') && typeof row.text === 'string') {
      return [row.text];
    }
    if (typeof row.content === 'string' && row.type === 'text') {
      return [row.content];
    }
    return [];
  }).join('\n');
}

function readThinkingFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row) {
      return [];
    }
    const type = typeof row.type === 'string' ? row.type : '';
    if ((type === 'thinking' || type === 'thought') && typeof row.thinking === 'string') {
      return [row.thinking];
    }
    if ((type === 'thinking' || type === 'thought') && typeof row.text === 'string') {
      return [row.text];
    }
    return [];
  });
}

function extractImages(content: unknown): SessionRenderImage[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => asRecord(block) ? extractImagesFromSingleBlock(block) : []);
}

function extractImageFiles(content: unknown): SessionRenderAttachedFile[] {
  return extractImagesAsAttachedFiles(content).filter((file) => file.source !== 'message-ref');
}

function extractContentMedia(value: unknown): MediaBundle {
  if (Array.isArray(value)) {
    return mergeMedia({
      images: extractImages(value),
      attachedFiles: extractImageFiles(value),
    });
  }
  const record = asRecord(value);
  if (!record) {
    return mergeMedia();
  }
  return mergeMedia({
    images: extractImages(record.content),
    attachedFiles: extractImageFiles(record.content),
  });
}

function extractToolOutputMedia(tool: CanonicalToolState): MediaBundle {
  return mergeMedia(extractContentMedia(tool.output), {
    attachedFiles: extractToolResultMediaAttachments({
      output: tool.output,
      outputText: tool.outputText,
    }),
  });
}

function messageAttachedFiles(message: CanonicalMessageState): SessionRenderAttachedFile[] {
  return mergeMedia({ attachedFiles: message.attachedFiles }).attachedFiles;
}

function mediaImageKey(image: SessionRenderImage): string {
  return `${image.mimeType}|${image.url ?? ''}|${image.data ?? ''}`;
}

function mediaFileKey(file: SessionRenderAttachedFile): string {
  return [
    file.fileName,
    file.mimeType,
    file.fileSize,
    file.preview ?? '',
    file.filePath ?? '',
    file.gatewayUrl ?? '',
    file.source ?? '',
  ].join('|');
}

function mergeMedia(...bundles: ReadonlyArray<{
  images?: ReadonlyArray<SessionRenderImage>;
  attachedFiles?: ReadonlyArray<SessionRenderAttachedFile>;
}>): MediaBundle {
  const imageKeys = new Set<string>();
  const fileKeys = new Set<string>();
  const images: SessionRenderImage[] = [];
  const attachedFiles: SessionRenderAttachedFile[] = [];
  for (const bundle of bundles) {
    for (const image of bundle.images ?? []) {
      const key = mediaImageKey(image);
      if (!imageKeys.has(key)) {
        imageKeys.add(key);
        images.push(structuredClone(image));
      }
    }
    for (const file of bundle.attachedFiles ?? []) {
      const key = mediaFileKey(file);
      if (!fileKeys.has(key)) {
        fileKeys.add(key);
        attachedFiles.push(structuredClone(file));
      }
    }
  }
  return { images, attachedFiles };
}

function buildMediaSegment(input: {
  key: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
}): SessionAssistantTurnSegment | null {
  const media = mergeMedia(input);
  if (media.images.length === 0 && media.attachedFiles.length === 0) {
    return null;
  }
  return {
    kind: 'media',
    key: input.key,
    images: media.images,
    attachedFiles: media.attachedFiles,
  };
}

function buildToolCard(tool: CanonicalToolState): SessionRenderToolCard {
  const outputText = tool.outputText ?? extractToolResultOutputText(tool.output);
  const renderState = resolveToolCardRenderState({
    name: tool.name,
    input: tool.input,
    output: tool.output,
    outputText,
  });
  return {
    id: tool.toolCallId,
    toolCallId: tool.toolCallId,
    name: tool.name,
    displayTitle: renderState.displayTitle,
    ...(renderState.displayDetail ? { displayDetail: renderState.displayDetail } : {}),
    input: tool.input,
    ...(renderState.inputText ? { inputText: renderState.inputText } : {}),
    status: tool.status,
    ...(tool.updatedAt != null && tool.createdAt != null ? { durationMs: Math.max(0, tool.updatedAt - tool.createdAt) } : {}),
    ...(tool.updatedAt != null ? { updatedAt: tool.updatedAt } : {}),
    ...(tool.output !== undefined ? { output: structuredClone(tool.output) } : {}),
    result: renderState.result,
  };
}

function buildToolSegment(key: string, tool: CanonicalToolState): SessionAssistantTurnSegment {
  return {
    kind: 'tool',
    key,
    tool: buildToolCard(tool),
  };
}

function graphStepDetail(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    const detail = JSON.stringify(value, null, 2);
    return detail === undefined ? undefined : detail;
  } catch {
    return undefined;
  }
}

function buildGraphStepsFromCanonicalState(input: {
  messages: ReadonlyArray<CanonicalMessageState>;
  tools: ReadonlyArray<CanonicalToolState>;
}): SessionExecutionGraphStep[] {
  const steps: SessionExecutionGraphStep[] = [];
  for (const message of input.messages) {
    for (const thought of readThinkingFromContent(message.content)) {
      if (!thought.trim()) {
        continue;
      }
      steps.push({
        id: `thinking:${message.key}:${steps.length}`,
        label: 'Thinking',
        status: message.status === 'error' ? 'error' : message.status === 'streaming' ? 'running' : 'completed',
        kind: 'thinking',
        detail: thought.trim(),
        depth: 1,
      });
    }
  }
  for (const tool of input.tools) {
    steps.push({
      id: tool.toolCallId,
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: graphStepDetail(tool.outputText ?? tool.partialResult ?? tool.input),
      depth: 1,
    });
  }
  return steps.slice(-MAX_EXECUTION_GRAPH_STEPS);
}

function appendToolOutputMediaSegment(input: {
  segments: SessionAssistantTurnSegment[];
  turnKey: string;
  laneKey: string;
  tool: CanonicalToolState;
}): void {
  if (input.tool.output === undefined) {
    return;
  }
  const media = extractToolOutputMedia(input.tool);
  const mediaSegment = buildMediaSegment({
    key: `media:${input.turnKey}:${input.laneKey}:tool:${input.tool.toolCallId}`,
    images: media.images,
    attachedFiles: media.attachedFiles,
  });
  if (mediaSegment && !input.segments.some((segment) => segment.key === mediaSegment.key)) {
    input.segments.push(mediaSegment);
  }
}

function appendToolSegment(input: {
  segments: SessionAssistantTurnSegment[];
  renderedToolCallIds: Set<string>;
  turnKey: string;
  laneKey: string;
  tool: CanonicalToolState;
}): void {
  if (input.renderedToolCallIds.has(input.tool.toolCallId)) {
    return;
  }
  input.renderedToolCallIds.add(input.tool.toolCallId);
  input.segments.push(buildToolSegment(`tool:${input.turnKey}:${input.laneKey}:${input.tool.toolCallId}`, input.tool));
  appendToolOutputMediaSegment(input);
}

function contentToolCallId(block: Record<string, unknown>): string {
  const type = typeof block.type === 'string' ? block.type : '';
  if (!isToolCallContentType(type) && !isToolResultContentType(type)) {
    return '';
  }
  return resolveToolRecordCallId(block);
}

function buildSegmentsFromCanonicalMessage(message: CanonicalMessageState, tools: ReadonlyArray<CanonicalToolState>): SessionAssistantTurnSegment[] {
  const laneKey = message.laneKey || 'main';
  const turnKey = messageTurnKey(message);
  const segments: SessionAssistantTurnSegment[] = [];
  const renderedToolCallIds = new Set<string>();
  const toolByCallId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const content = Array.isArray(message.content) ? message.content : null;
  let slot = 0;

  if (content) {
    for (const block of content) {
      const row = asRecord(block);
      if (!row) {
        continue;
      }
      const type = typeof row.type === 'string' ? row.type : '';
      const toolCallId = contentToolCallId(row);
      if (toolCallId) {
        const tool = toolByCallId.get(toolCallId);
        if (tool) {
          appendToolSegment({ segments, renderedToolCallIds, turnKey, laneKey, tool });
        }
        continue;
      }
      const segmentKey = `${turnKey}:${laneKey}:${slot++}`;
      if ((type === 'thinking' || type === 'thought') && (typeof row.thinking === 'string' || typeof row.text === 'string')) {
        segments.push({
          kind: 'thinking',
          key: `thinking:${segmentKey}`,
          text: String(row.thinking ?? row.text).trim(),
        });
        continue;
      }
      if (type === 'text' && typeof row.text === 'string' && row.text.trim()) {
        segments.push({
          kind: 'message',
          key: `message:${segmentKey}`,
          text: row.text.trim(),
        });
        continue;
      }
      if (type === 'image') {
        const mediaSegment = buildMediaSegment({
          key: `media:${segmentKey}`,
          images: extractImagesFromSingleBlock(row),
          attachedFiles: extractImageFiles([row]),
        });
        if (mediaSegment) {
          segments.push(mediaSegment);
        }
      }
    }
  }

  if (segments.length === 0) {
    for (const text of readThinkingFromContent(message.content)) {
      segments.push({
        kind: 'thinking',
        key: `thinking:${turnKey}:${laneKey}:${segments.length}`,
        text: text.trim(),
      });
    }
    const text = message.text || readTextFromContent(message.content);
    if (text.trim()) {
      segments.push({
        kind: 'message',
        key: `message:${turnKey}:${laneKey}:${segments.length}`,
        text: text.trim(),
      });
    }
  }

  for (const tool of tools) {
    appendToolSegment({ segments, renderedToolCallIds, turnKey, laneKey, tool });
  }

  const extraMessageMedia = mergeMedia({ attachedFiles: messageAttachedFiles(message) });
  const mediaSegment = buildMediaSegment({
    key: `media:${turnKey}:${laneKey}:message`,
    images: extraMessageMedia.images,
    attachedFiles: extraMessageMedia.attachedFiles,
  });
  if (mediaSegment && !segments.some((segment) => segment.key === mediaSegment.key)) {
    segments.push(mediaSegment);
  }

  return segments.filter((segment) => segment.kind !== 'thinking' || segment.text.trim().length > 0);
}

function groupKey(runId: string | undefined, laneKey: string): string {
  return `${runId ?? ''}::${laneKey}`;
}

function messageTurnKey(message: CanonicalMessageState): string {
  return message.messageId || message.clientId || message.originMessageId || message.key;
}

function messageTurnIdentity(message: CanonicalMessageState): {
  source: 'message' | 'client' | 'origin' | 'heuristic';
  mode: 'message' | 'client' | 'origin' | 'heuristic';
  confidence: 'strong' | 'fallback';
} {
  if (message.messageId) {
    return { source: 'message', mode: 'message', confidence: 'strong' };
  }
  if (message.clientId) {
    return { source: 'client', mode: 'client', confidence: 'strong' };
  }
  if (message.originMessageId) {
    return { source: 'origin', mode: 'origin', confidence: 'strong' };
  }
  return { source: 'heuristic', mode: 'heuristic', confidence: 'fallback' };
}

function projectionOrderValue(value: { createdAt?: number; updatedAt?: number; seq?: number }, fallbackIndex: number): number {
  if (typeof value.createdAt === 'number') {
    return value.createdAt;
  }
  if (typeof value.updatedAt === 'number') {
    return value.updatedAt;
  }
  if (typeof value.seq === 'number') {
    return value.seq;
  }
  return fallbackIndex;
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function buildStateProjectionIndex(state: CanonicalSessionState): {
  toolsByGroup: Map<string, CanonicalToolState[]>;
  assistantMessagesByGroup: Map<string, CanonicalMessageState[]>;
  toolsByMessageKey: Map<string, CanonicalToolState[]>;
} {
  const toolsByGroup = new Map<string, CanonicalToolState[]>();
  const assistantMessagesByGroup = new Map<string, CanonicalMessageState[]>();
  const toolsByMessageKey = new Map<string, CanonicalToolState[]>();

  for (const message of state.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    pushMapValue(assistantMessagesByGroup, groupKey(message.runId, message.laneKey || 'main'), message);
  }

  state.tools.forEach((tool, toolIndex) => {
    const key = groupKey(tool.runId, tool.laneKey || 'main');
    pushMapValue(toolsByGroup, key, tool);
    const messages = assistantMessagesByGroup.get(key) ?? [];
    const toolOrder = projectionOrderValue(tool, toolIndex);
    const owner = messages.reduce<CanonicalMessageState | null>((selected, message, messageIndex) => {
      const messageOrder = projectionOrderValue(message, messageIndex);
      if (messageOrder > toolOrder) {
        return selected;
      }
      if (!selected) {
        return message;
      }
      return messageOrder >= projectionOrderValue(selected, messageIndex) ? message : selected;
    }, null);
    if (owner) {
      pushMapValue(toolsByMessageKey, owner.key, tool);
    }
  });

  return { toolsByGroup, assistantMessagesByGroup, toolsByMessageKey };
}

function buildAssistantEntry(sessionId: string, message: CanonicalMessageState, tools: ReadonlyArray<CanonicalToolState>): SessionTimelineAssistantTurnEntry {
  const laneKey = message.laneKey || 'main';
  const turnKey = messageTurnKey(message);
  const identity = messageTurnIdentity(message);
  return buildAssistantTurnEntry({
    identity: {
      sessionKey: sessionId,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      laneKey,
      turnKey,
      turnBindingSource: identity.source,
      turnBindingConfidence: identity.confidence,
      turnIdentityMode: identity.mode,
      turnIdentityConfidence: identity.confidence,
      entryId: `canonical:${message.key}`,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
    },
    status: message.status === 'streaming' ? 'streaming' : message.status,
    text: message.text,
    ...(message.createdAt != null ? { createdAt: message.createdAt } : {}),
    ...(message.seq != null ? { sequenceId: message.seq } : {}),
    segments: buildSegmentsFromCanonicalMessage(message, tools),
    isStreaming: message.status === 'streaming',
  });
}

function buildUserTimelineEntry(sessionId: string, message: CanonicalMessageState): SessionTimelineUserMessageEntry {
  return {
    key: `session:${sessionId}|user:${message.key}`,
    kind: 'user-message',
    sessionKey: sessionId,
    role: 'user',
    text: message.text,
    images: mergeMedia({ images: extractImages(message.content) }, { images: message.images }).images,
    attachedFiles: mergeMedia({ attachedFiles: extractImagesAsAttachedFiles(message.content) }, { attachedFiles: messageAttachedFiles(message) }).attachedFiles,
    status: message.status === 'streaming' ? 'streaming' : message.status,
    entryId: `canonical:${message.key}`,
    ...(message.createdAt != null ? { createdAt: message.createdAt } : {}),
    ...(message.updatedAt != null ? { updatedAt: message.updatedAt } : {}),
    ...(message.seq != null ? { sequenceId: message.seq } : {}),
    ...(message.runId ? { runId: message.runId } : {}),
    laneKey: message.laneKey,
    turnKey: messageTurnKey(message),
    turnBindingSource: messageTurnIdentity(message).source,
    turnBindingConfidence: messageTurnIdentity(message).confidence,
    turnIdentityMode: messageTurnIdentity(message).mode,
    turnIdentityConfidence: messageTurnIdentity(message).confidence,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
  };
}

function timelineEntryOrderValue(entry: SessionTimelineEntry, fallbackIndex: number): number {
  if (typeof entry.createdAt === 'number') {
    return entry.createdAt;
  }
  if (typeof entry.sequenceId === 'number') {
    return entry.sequenceId;
  }
  return fallbackIndex;
}

function sortTimelineEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftOrder = timelineEntryOrderValue(left.entry, left.index);
      const rightOrder = timelineEntryOrderValue(right.entry, right.index);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const leftSeq = typeof left.entry.sequenceId === 'number' ? left.entry.sequenceId : left.index;
      const rightSeq = typeof right.entry.sequenceId === 'number' ? right.entry.sequenceId : right.index;
      if (leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function buildExecutionGraphItemsFromProjectionIndex(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
): SessionRenderExecutionGraphItem[] {
  return state.teams.map((event, index): SessionRenderExecutionGraphItem => {
    const completion = event.event;
    const laneKey = event.laneKey || completion.laneKey || 'main';
    const runId = event.runId || completion.turnKey;
    const graphId = `${state.sessionId}:${completion.childSessionKey}:${event.eventId}`;
    const childAgentId = completion.childAgentId ?? completion.agentId;
    return {
      key: `session:${state.sessionId}|graph:${graphId}`,
      kind: 'execution-graph',
      sessionKey: state.sessionId,
      role: 'assistant',
      text: '',
      ...(event.timestamp != null ? { createdAt: event.timestamp } : {}),
      status: 'final',
      entryId: `canonical:${event.eventId}`,
      graphId,
      completionItemKey: `canonical:${event.eventId}`,
      ...(runId ? { runId } : {}),
      laneKey,
      turnKey: runId || completion.turnKey || `team:${index}`,
      anchorItemKey: runId ? buildAssistantTurnEntryKey(state.sessionId, laneKey, runId) : undefined,
      childSessionKey: completion.childSessionKey,
      ...(completion.childSessionId ? { childSessionId: completion.childSessionId } : {}),
      ...(childAgentId ? { childAgentId } : {}),
      agentLabel: childAgentId || 'subagent',
      sessionLabel: completion.childSessionId || completion.childSessionKey,
      steps: buildGraphStepsFromCanonicalState({
        messages: projectionIndex.assistantMessagesByGroup.get(groupKey(runId, laneKey)) ?? [],
        tools: projectionIndex.toolsByGroup.get(groupKey(runId, laneKey)) ?? [],
      }),
      active: false,
      triggerItemKey: runId ? buildAssistantTurnEntryKey(state.sessionId, laneKey, runId) : undefined,
      ...(runId ? { replyItemKey: buildAssistantTurnEntryKey(state.sessionId, laneKey, runId) } : {}),
    };
  });
}

export function buildExecutionGraphItemsFromCanonicalState(state: CanonicalSessionState): SessionRenderExecutionGraphItem[] {
  return buildExecutionGraphItemsFromProjectionIndex(state, buildStateProjectionIndex(state));
}

function buildTimelineEntriesFromProjectionIndex(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const renderedToolCallIds = new Set<string>();
  for (const message of state.messages) {
    if (message.role === 'assistant') {
      const tools = projectionIndex.toolsByMessageKey.get(message.key) ?? [];
      for (const tool of tools) {
        renderedToolCallIds.add(tool.toolCallId);
      }
      entries.push(buildAssistantEntry(state.sessionId, message, tools));
      continue;
    }
    if (message.role === 'user') {
      entries.push(buildUserTimelineEntry(state.sessionId, message));
      continue;
    }
    if (message.role === 'system') {
      entries.push({
        key: `session:${state.sessionId}|system:${message.key}`,
        kind: 'system',
        sessionId: state.sessionId,
        role: 'system',
        level: 'info',
        text: message.text,
        status: message.status === 'streaming' ? 'streaming' : message.status,
        ...(message.createdAt != null ? { createdAt: message.createdAt } : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        entryId: `canonical:${message.key}`,
      });
    }
  }
  for (const tool of state.tools) {
    if (renderedToolCallIds.has(tool.toolCallId)) {
      continue;
    }
    const laneKey = tool.laneKey || 'main';
    const turnKey = `tool:${tool.toolCallId}`;
    entries.push(buildAssistantTurnEntry({
      identity: {
        sessionKey: state.sessionId,
        ...(tool.runId ? { runId: tool.runId } : {}),
        ...(tool.agentId ? { agentId: tool.agentId } : {}),
        laneKey,
        turnKey,
        turnBindingSource: 'tool_call',
        turnBindingConfidence: 'strong',
        turnIdentityMode: 'tool_call',
        turnIdentityConfidence: 'strong',
        entryId: `canonical:${tool.key}`,
      },
      status: tool.status === 'running' ? 'streaming' : 'final',
      text: '',
      ...(tool.createdAt != null ? { createdAt: tool.createdAt } : {}),
      ...(tool.seq != null ? { sequenceId: tool.seq } : {}),
      segments: [buildToolSegment(`tool:${turnKey}:${laneKey}:${tool.toolCallId}`, tool)],
      isStreaming: tool.status === 'running',
    }));
  }
  return sortTimelineEntries(entries);
}

export function buildTimelineEntriesFromCanonicalState(state: CanonicalSessionState): SessionTimelineEntry[] {
  return buildTimelineEntriesFromProjectionIndex(state, buildStateProjectionIndex(state));
}

export function buildRenderItemIndexByKey(items: ReadonlyArray<SessionRenderItem>): Map<string, number> {
  return new Map(items.map((item, index) => [item.key, index]));
}

function buildProjectionRenderItemKeyIndex(input: {
  state: CanonicalSessionState;
  timelineEntries: ReadonlyArray<SessionTimelineEntry>;
}): CanonicalProjectionRenderItemKeyIndex {
  const messageItemKeyByCanonicalKey = new Map<string, string>();
  const toolItemKeyByCanonicalKey = new Map<string, string>();
  const toolKeyByCallId = new Map(input.state.tools.map((tool) => [tool.toolCallId, tool.key]));
  for (const entry of input.timelineEntries) {
    if (entry.kind === 'user-message') {
      const canonicalKey = entry.entryId.startsWith('canonical:') ? entry.entryId.slice('canonical:'.length) : '';
      if (canonicalKey) {
        messageItemKeyByCanonicalKey.set(canonicalKey, entry.key);
      }
      continue;
    }
    if (entry.kind !== 'assistant-turn') {
      continue;
    }
    const canonicalKey = entry.entryId.startsWith('canonical:') ? entry.entryId.slice('canonical:'.length) : '';
    if (canonicalKey) {
      messageItemKeyByCanonicalKey.set(canonicalKey, entry.key);
    }
    for (const segment of entry.segments) {
      if (segment.kind !== 'tool') {
        continue;
      }
      const toolKey = toolKeyByCallId.get(segment.tool.toolCallId);
      if (toolKey) {
        toolItemKeyByCanonicalKey.set(toolKey, entry.key);
      }
    }
  }
  return { messageItemKeyByCanonicalKey, toolItemKeyByCanonicalKey };
}

export function buildProjectedCanonicalSessionState(state: CanonicalSessionState): {
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionRenderExecutionGraphItem[];
  renderItems: SessionRenderItem[];
  renderItemIndexByKey: Map<string, number>;
  renderItemKeyIndex: CanonicalProjectionRenderItemKeyIndex;
} {
  const projectionIndex = buildStateProjectionIndex(state);
  const timelineEntries = buildTimelineEntriesFromProjectionIndex(state, projectionIndex);
  const executionGraphItems = buildExecutionGraphItemsFromProjectionIndex(state, projectionIndex);
  const renderItems = buildRenderItemsFromTimeline({
    sessionKey: state.sessionId,
    timelineEntries,
    executionGraphItems,
    runtime: state.runtime,
  });
  return {
    timelineEntries,
    executionGraphItems,
    renderItems,
    renderItemIndexByKey: buildRenderItemIndexByKey(renderItems),
    renderItemKeyIndex: buildProjectionRenderItemKeyIndex({ state, timelineEntries }),
  };
}

export function buildRenderItemsFromCanonicalState(input: {
  state: CanonicalSessionState;
  executionGraphItems?: SessionRenderExecutionGraphItem[];
  timelineEntries?: SessionTimelineEntry[];
}): SessionRenderItem[] {
  if (input.timelineEntries || input.executionGraphItems) {
    return buildRenderItemsFromTimeline({
      sessionKey: input.state.sessionId,
      timelineEntries: input.timelineEntries ?? buildTimelineEntriesFromCanonicalState(input.state),
      executionGraphItems: input.executionGraphItems ?? buildExecutionGraphItemsFromCanonicalState(input.state),
      runtime: input.state.runtime,
    });
  }
  return buildProjectedCanonicalSessionState(input.state).renderItems;
}

export { buildAssistantTurnEntryKey };
