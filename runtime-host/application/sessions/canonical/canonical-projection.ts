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
import { sanitizeAssistantDisplayText } from '../../../shared/chat-message-normalization';
import { extractToolResultMediaAttachments } from '../tool-result-media';
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordCallId,
} from '../state-only-tools';
import { buildCanonicalMessageStateKey, buildCanonicalToolStateKey } from './canonical-reducer';
import type { CanonicalSessionEvent } from './canonical-events';
import type { CanonicalMessageState, CanonicalSessionState, CanonicalThoughtState, CanonicalToolState } from './canonical-state';
import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';

type MediaBundle = {
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
};

export type CanonicalProjectionRenderItemKeyIndex = {
  messageItemKeyByCanonicalKey: Map<string, string>;
  toolItemKeyByCanonicalKey: Map<string, string>;
};

export interface IncrementalCanonicalSessionProjectionInput {
  state: CanonicalSessionState;
  committedEvents: readonly CanonicalSessionEvent[];
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionRenderExecutionGraphItem[];
}

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
  thoughts?: ReadonlyArray<CanonicalThoughtState>;
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
  for (const thought of input.thoughts ?? []) {
    if (!thought.text.trim()) {
      continue;
    }
    steps.push({
      id: thought.key,
      label: 'Thinking',
      status: thought.status === 'error' ? 'error' : thought.status === 'streaming' ? 'running' : 'completed',
      kind: 'thinking',
      detail: thought.text.trim(),
      depth: 1,
    });
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

function appendMessageContentSegments(input: {
  segments: SessionAssistantTurnSegment[];
  renderedToolCallIds: Set<string>;
  message: CanonicalMessageState;
  toolsByCallId: ReadonlyMap<string, CanonicalToolState>;
  turnKey: string;
  laneKey: string;
  slotOffset: number;
}): number {
  const content = Array.isArray(input.message.content) ? input.message.content : null;
  let slot = input.slotOffset;
  if (content) {
    for (const block of content) {
      const row = asRecord(block);
      if (!row) {
        continue;
      }
      const type = typeof row.type === 'string' ? row.type : '';
      const toolCallId = contentToolCallId(row);
      if (toolCallId) {
        const tool = input.toolsByCallId.get(toolCallId);
        if (tool) {
          appendToolSegment({
            segments: input.segments,
            renderedToolCallIds: input.renderedToolCallIds,
            turnKey: input.turnKey,
            laneKey: input.laneKey,
            tool,
          });
        }
        continue;
      }
      const segmentKey = `${input.turnKey}:${input.laneKey}:${slot++}`;
      if ((type === 'thinking' || type === 'thought') && (typeof row.thinking === 'string' || typeof row.text === 'string')) {
        input.segments.push({
          kind: 'thinking',
          key: `thinking:${segmentKey}`,
          text: String(row.thinking ?? row.text).trim(),
        });
        continue;
      }
      if (type === 'text' && typeof row.text === 'string') {
        const text = sanitizeAssistantDisplayText(row.text);
        if (text) {
          input.segments.push({
            kind: 'message',
            key: `message:${segmentKey}`,
            text,
          });
        }
        continue;
      }
      if (type === 'image') {
        const mediaSegment = buildMediaSegment({
          key: `media:${segmentKey}`,
          images: extractImagesFromSingleBlock(row),
          attachedFiles: extractImageFiles([row]),
        });
        if (mediaSegment) {
          input.segments.push(mediaSegment);
        }
      }
    }
  }

  if (slot === input.slotOffset) {
    for (const text of readThinkingFromContent(input.message.content)) {
      input.segments.push({
        kind: 'thinking',
        key: `thinking:${input.turnKey}:${input.laneKey}:${slot++}`,
        text: text.trim(),
      });
    }
    const text = sanitizeAssistantDisplayText(input.message.text || readTextFromContent(input.message.content));
    if (text) {
      input.segments.push({
        kind: 'message',
        key: `message:${input.turnKey}:${input.laneKey}:${slot++}`,
        text,
      });
    }
  }

  const extraMessageMedia = mergeMedia({ attachedFiles: messageAttachedFiles(input.message) });
  const mediaSegment = buildMediaSegment({
    key: `media:${input.turnKey}:${input.laneKey}:message:${input.message.key}`,
    images: extraMessageMedia.images,
    attachedFiles: extraMessageMedia.attachedFiles,
  });
  if (mediaSegment && !input.segments.some((segment) => segment.key === mediaSegment.key)) {
    input.segments.push(mediaSegment);
  }
  return slot;
}

function canonicalRowOrderValue(value: { seq?: number; createdAt?: number; updatedAt?: number }, fallbackIndex: number): number {
  if (typeof value.seq === 'number') {
    return value.seq;
  }
  if (typeof value.createdAt === 'number') {
    return value.createdAt;
  }
  if (typeof value.updatedAt === 'number') {
    return value.updatedAt;
  }
  return fallbackIndex;
}

type AssistantTurnSegmentRow =
  | { kind: 'message'; message: CanonicalMessageState; order: number; index: number }
  | { kind: 'tool'; tool: CanonicalToolState; order: number; index: number }
  | { kind: 'thought'; thought: CanonicalThoughtState; order: number; index: number };

function buildSegmentsFromCanonicalTurnRows(input: {
  turnKey: string;
  laneKey: string;
  messages: ReadonlyArray<CanonicalMessageState>;
  tools: ReadonlyArray<CanonicalToolState>;
  thoughts: ReadonlyArray<CanonicalThoughtState>;
}): SessionAssistantTurnSegment[] {
  const segments: SessionAssistantTurnSegment[] = [];
  const renderedToolCallIds = new Set<string>();
  const toolsByCallId = new Map(input.tools.map((tool) => [tool.toolCallId, tool]));
  let slot = 0;
  const rows: AssistantTurnSegmentRow[] = [
    ...input.messages.map((message, index) => ({ kind: 'message' as const, message, order: canonicalRowOrderValue(message, index), index })),
    ...input.tools.map((tool, index) => ({ kind: 'tool' as const, tool, order: canonicalRowOrderValue(tool, input.messages.length + index), index })),
    ...input.thoughts.map((thought, index) => ({ kind: 'thought' as const, thought, order: canonicalRowOrderValue(thought, input.messages.length + input.tools.length + index), index })),
  ].sort((left, right) => left.order - right.order || left.index - right.index);

  for (const row of rows) {
    if (row.kind === 'message') {
      slot = appendMessageContentSegments({
        segments,
        renderedToolCallIds,
        message: row.message,
        toolsByCallId,
        turnKey: input.turnKey,
        laneKey: input.laneKey,
        slotOffset: slot,
      });
      continue;
    }
    if (row.kind === 'tool') {
      appendToolSegment({ segments, renderedToolCallIds, turnKey: input.turnKey, laneKey: input.laneKey, tool: row.tool });
      continue;
    }
    if (row.thought.text.trim()) {
      segments.push({
        kind: 'thinking',
        key: `thinking:${input.turnKey}:${input.laneKey}:state:${row.thought.key}`,
        text: row.thought.text.trim(),
      });
    }
  }

  return segments.filter((segment) => segment.kind !== 'thinking' || segment.text.trim().length > 0);
}

function buildSegmentsFromCanonicalMessage(message: CanonicalMessageState, tools: ReadonlyArray<CanonicalToolState>, thoughts: ReadonlyArray<CanonicalThoughtState> = []): SessionAssistantTurnSegment[] {
  return buildSegmentsFromCanonicalTurnRows({
    turnKey: messageTurnKey(message),
    laneKey: message.laneKey || 'main',
    messages: [message],
    tools,
    thoughts,
  });
}

function groupKey(runId: string | undefined, laneKey: string): string {
  return `${runId ?? ''}::${laneKey}`;
}

function sessionBindingConfidence(value: 'high' | 'medium' | 'low' | undefined): SessionTurnBindingConfidence {
  return value === 'high' || value === 'medium' ? 'strong' : 'fallback';
}

function hasExplicitTurnBinding(value: { ownerTurnKey?: string; turnBindingConfidence?: 'high' | 'medium' | 'low' }): boolean {
  return !!value.ownerTurnKey && value.turnBindingConfidence !== 'low';
}

function messageOwnerKey(message: CanonicalMessageState): string {
  return message.ownerMessageKey || message.key;
}

function messageTurnKey(message: CanonicalMessageState): string {
  if (hasExplicitTurnBinding(message)) {
    return message.ownerTurnKey!;
  }
  return messageOwnerKey(message);
}

function toolTurnKey(tool: CanonicalToolState): string {
  if (hasExplicitTurnBinding(tool)) {
    return tool.ownerTurnKey!;
  }
  return `tool:${tool.toolCallId}`;
}

function thoughtTurnKey(thought: CanonicalThoughtState): string {
  if (hasExplicitTurnBinding(thought)) {
    return thought.ownerTurnKey!;
  }
  return `thought:${thought.key}`;
}

function explicitTurnIdentity(input: {
  ownerTurnKey?: string;
  ownerMessageKey?: string;
  turnId?: string;
  turnBindingConfidence?: 'high' | 'medium' | 'low';
}): {
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnBindingConfidence;
} {
  if (input.ownerMessageKey && input.ownerTurnKey === input.ownerMessageKey) {
    return {
      source: 'message',
      mode: 'message',
      confidence: sessionBindingConfidence(input.turnBindingConfidence),
    };
  }
  return {
    source: input.turnId ? 'run' : 'heuristic',
    mode: input.turnId ? 'run' : 'heuristic',
    confidence: sessionBindingConfidence(input.turnBindingConfidence),
  };
}

function messageTurnIdentity(message: CanonicalMessageState): {
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnBindingConfidence;
} {
  if (!hasExplicitTurnBinding(message)) {
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
  return explicitTurnIdentity(message);
}

function toolTurnIdentity(tool: CanonicalToolState): {
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnBindingConfidence;
} {
  if (hasExplicitTurnBinding(tool)) {
    return explicitTurnIdentity(tool);
  }
  return { source: 'tool_call', mode: 'tool_call', confidence: 'strong' };
}

function thoughtTurnIdentity(thought: CanonicalThoughtState): {
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnBindingConfidence;
} {
  if (hasExplicitTurnBinding(thought)) {
    return explicitTurnIdentity(thought);
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

function thoughtOrderValue(thought: CanonicalThoughtState, fallbackIndex: number): number {
  if (typeof thought.updatedAt === 'number') {
    return thought.updatedAt;
  }
  if (typeof thought.seq === 'number') {
    return thought.seq;
  }
  return fallbackIndex;
}

function pickThoughtGroupOwner(thoughts: ReadonlyArray<CanonicalThoughtState>): CanonicalThoughtState | null {
  if (thoughts.length === 0) {
    return null;
  }
  return thoughts.reduce<CanonicalThoughtState | null>((selected, thought, index) => {
    if (!selected) {
      return thought;
    }
    return thoughtOrderValue(thought, index) <= thoughtOrderValue(selected, index) ? thought : selected;
  }, null);
}

function pickAssistantGroupOwner(messages: ReadonlyArray<CanonicalMessageState>): CanonicalMessageState | null {
  if (messages.length === 0) {
    return null;
  }
  return messages.reduce<CanonicalMessageState | null>((selected, message, index) => {
    if (!selected) {
      return message;
    }
    return projectionOrderValue(message, index) <= projectionOrderValue(selected, index) ? message : selected;
  }, null);
}

function projectKeys<T extends { key: string }>(keys: ReadonlyArray<string> | undefined, index: Map<string, number>, rows: ReadonlyArray<T>): T[] {
  if (!keys || keys.length === 0) {
    return [];
  }
  return keys.flatMap((key) => {
    const rowIndex = index.get(key);
    const row = rowIndex == null ? undefined : rows[rowIndex];
    return row ? [row] : [];
  });
}

function mergeCanonicalRowsByKey<T extends { key: string }>(...groups: ReadonlyArray<ReadonlyArray<T> | undefined>): T[] {
  const merged: T[] = [];
  const seenKeys = new Set<string>();
  for (const group of groups) {
    for (const row of group ?? []) {
      if (seenKeys.has(row.key)) {
        continue;
      }
      seenKeys.add(row.key);
      merged.push(row);
    }
  }
  return merged;
}

function resolveAssistantMessageTools(
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  message: CanonicalMessageState,
): CanonicalToolState[] {
  return mergeCanonicalRowsByKey(
    projectionIndex.toolsByMessageKey.get(messageOwnerKey(message)),
    projectionIndex.toolsByTurnKey.get(messageTurnKey(message)),
  );
}

function resolveAssistantMessageThoughts(
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  message: CanonicalMessageState,
): CanonicalThoughtState[] {
  return mergeCanonicalRowsByKey(
    projectionIndex.thoughtsByMessageKey.get(messageOwnerKey(message)),
    projectionIndex.thoughtsByTurnKey.get(messageTurnKey(message)),
  );
}

function findAssistantMessageCanonicalKeysForTool(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  tool: CanonicalToolState,
): Set<string> {
  const affectedCanonicalKeys = new Set<string>();
  for (const message of state.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    if (resolveAssistantMessageTools(projectionIndex, message).some((candidate) => candidate.key === tool.key)) {
      affectedCanonicalKeys.add(message.key);
    }
  }
  return affectedCanonicalKeys;
}

function buildStateProjectionIndex(state: CanonicalSessionState): {
  toolsByGroup: Map<string, CanonicalToolState[]>;
  assistantMessagesByGroup: Map<string, CanonicalMessageState[]>;
  toolsByMessageKey: Map<string, CanonicalToolState[]>;
  toolsByTurnKey: Map<string, CanonicalToolState[]>;
  thoughtsByGroup: Map<string, CanonicalThoughtState[]>;
  thoughtsByMessageKey: Map<string, CanonicalThoughtState[]>;
  thoughtsByTurnKey: Map<string, CanonicalThoughtState[]>;
} {
  const toolsByGroup = new Map<string, CanonicalToolState[]>();
  const assistantMessagesByGroup = new Map<string, CanonicalMessageState[]>();
  const toolsByMessageKey = new Map<string, CanonicalToolState[]>();
  const toolsByTurnKey = new Map<string, CanonicalToolState[]>();
  const thoughtsByGroup = new Map<string, CanonicalThoughtState[]>();
  const thoughtsByMessageKey = new Map<string, CanonicalThoughtState[]>();
  const thoughtsByTurnKey = new Map<string, CanonicalThoughtState[]>();

  for (const message of state.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    pushMapValue(assistantMessagesByGroup, groupKey(message.runId, message.laneKey || 'main'), message);
    toolsByMessageKey.set(messageOwnerKey(message), projectKeys(state.toolKeysByOwnerMessageKey.get(messageOwnerKey(message)), state.toolIndexByKey, state.tools));
    thoughtsByMessageKey.set(messageOwnerKey(message), projectKeys(state.thoughtKeysByOwnerMessageKey.get(messageOwnerKey(message)), state.thoughtIndexByKey, state.thoughts));
    const turnKey = messageTurnKey(message);
    toolsByTurnKey.set(turnKey, projectKeys(state.toolKeysByOwnerTurnKey.get(turnKey), state.toolIndexByKey, state.tools));
    thoughtsByTurnKey.set(turnKey, projectKeys(state.thoughtKeysByOwnerTurnKey.get(turnKey), state.thoughtIndexByKey, state.thoughts));
  }

  state.tools.forEach((tool) => {
    pushMapValue(toolsByGroup, groupKey(tool.runId, tool.laneKey || 'main'), tool);
    if (tool.ownerMessageKey && !toolsByMessageKey.has(tool.ownerMessageKey)) {
      toolsByMessageKey.set(tool.ownerMessageKey, projectKeys(state.toolKeysByOwnerMessageKey.get(tool.ownerMessageKey), state.toolIndexByKey, state.tools));
    }
    if (hasExplicitTurnBinding(tool) && tool.ownerTurnKey && !toolsByTurnKey.has(tool.ownerTurnKey)) {
      toolsByTurnKey.set(tool.ownerTurnKey, projectKeys(state.toolKeysByOwnerTurnKey.get(tool.ownerTurnKey), state.toolIndexByKey, state.tools));
    }
  });

  for (const thought of state.thoughts) {
    pushMapValue(thoughtsByGroup, groupKey(thought.runId, thought.laneKey || 'main'), thought);
    if (thought.ownerMessageKey && !thoughtsByMessageKey.has(thought.ownerMessageKey)) {
      thoughtsByMessageKey.set(thought.ownerMessageKey, projectKeys(state.thoughtKeysByOwnerMessageKey.get(thought.ownerMessageKey), state.thoughtIndexByKey, state.thoughts));
    }
    if (hasExplicitTurnBinding(thought) && thought.ownerTurnKey && !thoughtsByTurnKey.has(thought.ownerTurnKey)) {
      thoughtsByTurnKey.set(thought.ownerTurnKey, projectKeys(state.thoughtKeysByOwnerTurnKey.get(thought.ownerTurnKey), state.thoughtIndexByKey, state.thoughts));
    }
  }

  return { toolsByGroup, assistantMessagesByGroup, toolsByMessageKey, toolsByTurnKey, thoughtsByGroup, thoughtsByMessageKey, thoughtsByTurnKey };
}

export function buildAssistantEntry(sessionId: string, message: CanonicalMessageState, tools: ReadonlyArray<CanonicalToolState>, thoughts: ReadonlyArray<CanonicalThoughtState> = []): SessionTimelineAssistantTurnEntry {
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
    text: sanitizeAssistantDisplayText(message.text),
    ...(message.createdAt != null ? { createdAt: message.createdAt } : {}),
    ...(message.updatedAt != null ? { updatedAt: message.updatedAt } : {}),
    ...(message.seq != null ? { sequenceId: message.seq } : {}),
    segments: buildSegmentsFromCanonicalMessage(message, tools, thoughts),
    isStreaming: message.status === 'streaming',
  });
}

function combinedAssistantStatus(messages: ReadonlyArray<CanonicalMessageState>, tools: ReadonlyArray<CanonicalToolState>): SessionTimelineAssistantTurnEntry['status'] {
  if (messages.some((message) => message.status === 'error')) {
    return 'error';
  }
  if (messages.some((message) => message.status === 'aborted')) {
    return 'aborted';
  }
  if (messages.some((message) => message.status === 'streaming') || tools.some((tool) => tool.status === 'running')) {
    return 'streaming';
  }
  return 'final';
}

function buildAssistantEntryForTurn(input: {
  sessionId: string;
  turnKey: string;
  messages: ReadonlyArray<CanonicalMessageState>;
  tools: ReadonlyArray<CanonicalToolState>;
  thoughts: ReadonlyArray<CanonicalThoughtState>;
}): SessionTimelineAssistantTurnEntry | null {
  const messageOwner = pickAssistantGroupOwner(input.messages);
  const toolOwner = input.tools[0];
  const owner = messageOwner ?? toolOwner;
  if (!owner) {
    return null;
  }
  const laneKey = owner.laneKey || 'main';
  const identity = messageOwner ? messageTurnIdentity(messageOwner) : toolTurnIdentity(toolOwner!);
  const status = combinedAssistantStatus(input.messages, input.tools);
  const text = input.messages
    .map((message) => sanitizeAssistantDisplayText(message.text))
    .filter(Boolean)
    .join('\n');
  return buildAssistantTurnEntry({
    identity: {
      sessionKey: input.sessionId,
      ...(owner.runId ? { runId: owner.runId } : {}),
      ...(owner.agentId ? { agentId: owner.agentId } : {}),
      laneKey,
      turnKey: input.turnKey,
      turnBindingSource: identity.source,
      turnBindingConfidence: identity.confidence,
      turnIdentityMode: identity.mode,
      turnIdentityConfidence: identity.confidence,
      entryId: `canonical:${owner.key}`,
      ...(messageOwner?.messageId ? { messageId: messageOwner.messageId } : {}),
      ...(messageOwner?.originMessageId ? { originMessageId: messageOwner.originMessageId } : {}),
      ...(messageOwner?.clientId ? { clientId: messageOwner.clientId } : {}),
    },
    status,
    text,
    ...(owner.createdAt != null ? { createdAt: owner.createdAt } : {}),
    ...(input.messages.some((message) => message.updatedAt != null) || input.tools.some((tool) => tool.updatedAt != null)
      ? { updatedAt: Math.max(...[
          ...input.messages.map((message) => message.updatedAt ?? message.createdAt ?? 0),
          ...input.tools.map((tool) => tool.updatedAt ?? tool.createdAt ?? 0),
        ]) }
      : {}),
    ...(owner.seq != null ? { sequenceId: owner.seq } : {}),
    segments: buildSegmentsFromCanonicalTurnRows({
      turnKey: input.turnKey,
      laneKey,
      messages: input.messages,
      tools: input.tools,
      thoughts: input.thoughts,
    }),
    isStreaming: status === 'streaming',
  });
}

export function buildUserTimelineEntry(sessionId: string, message: CanonicalMessageState): SessionTimelineUserMessageEntry {
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

function deriveChildSessionIdentity(state: CanonicalSessionState, childSessionKey: string, childAgentId?: string): SessionIdentity {
  const agentId = childAgentId || state.context.identity.agentId;
  return {
    endpoint: state.context.identity.endpoint,
    agentId,
    sessionKey: childSessionKey,
  };
}

function buildExecutionGraphItemsFromProjectionIndex(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
): SessionRenderExecutionGraphItem[] {
  return state.teams.map((event, index): SessionRenderExecutionGraphItem => {
    const completion = event.event;
    const laneKey = event.laneKey || completion.laneKey || 'main';
    const runId = event.runId || completion.turnKey;
    const assistantTurnKey = completion.assistantTurnKey || undefined;
    const graphTurnKey = assistantTurnKey || completion.turnKey || `team:${index}`;
    const anchorTurnKey = assistantTurnKey || runId;
    const graphId = `${state.sessionId}:${completion.childSessionKey}:${event.eventId}`;
    const childAgentId = completion.childAgentId ?? completion.agentId;
    const childSessionIdentity = completion.childSessionIdentity ?? deriveChildSessionIdentity(state, completion.childSessionKey, childAgentId);
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
      turnKey: graphTurnKey,
      anchorItemKey: anchorTurnKey ? buildAssistantTurnEntryKey(state.sessionId, laneKey, anchorTurnKey) : undefined,
      childSessionKey: completion.childSessionKey,
      childSessionIdentity,
      ...(completion.childSessionId ? { childSessionId: completion.childSessionId } : {}),
      ...(childAgentId ? { childAgentId } : {}),
      agentLabel: childAgentId || 'subagent',
      sessionLabel: completion.childSessionId || completion.childSessionKey,
      steps: buildGraphStepsFromCanonicalState({
        messages: assistantTurnKey
          ? state.messages.filter((message) => message.role === 'assistant' && messageTurnKey(message) === assistantTurnKey)
          : projectionIndex.assistantMessagesByGroup.get(groupKey(runId, laneKey)) ?? [],
        thoughts: assistantTurnKey
          ? projectionIndex.thoughtsByTurnKey.get(assistantTurnKey) ?? []
          : runId ? projectionIndex.thoughtsByTurnKey.get(`run:${laneKey}:${runId}`) ?? projectionIndex.thoughtsByGroup.get(groupKey(runId, laneKey)) ?? [] : [],
        tools: assistantTurnKey
          ? projectionIndex.toolsByTurnKey.get(assistantTurnKey) ?? []
          : runId ? projectionIndex.toolsByTurnKey.get(`run:${laneKey}:${runId}`) ?? projectionIndex.toolsByGroup.get(groupKey(runId, laneKey)) ?? [] : [],
      }),
      active: false,
      triggerItemKey: anchorTurnKey ? buildAssistantTurnEntryKey(state.sessionId, laneKey, anchorTurnKey) : undefined,
      ...(anchorTurnKey ? { replyItemKey: buildAssistantTurnEntryKey(state.sessionId, laneKey, anchorTurnKey) } : {}),
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
  const renderedThoughtKeys = new Set<string>();
  const renderedAssistantTurnKeys = new Set<string>();
  const assistantMessagesByExplicitTurnKey = new Map<string, CanonicalMessageState[]>();
  for (const message of state.messages) {
    if (message.role === 'assistant' && hasExplicitTurnBinding(message)) {
      pushMapValue(assistantMessagesByExplicitTurnKey, messageTurnKey(message), message);
    }
  }
  for (const message of state.messages) {
    if (message.role === 'assistant') {
      const turnKey = messageTurnKey(message);
      if (hasExplicitTurnBinding(message)) {
        if (renderedAssistantTurnKeys.has(turnKey)) {
          continue;
        }
        renderedAssistantTurnKeys.add(turnKey);
        const messages = assistantMessagesByExplicitTurnKey.get(turnKey) ?? [message];
        const tools = mergeCanonicalRowsByKey(
          projectionIndex.toolsByTurnKey.get(turnKey),
          ...messages.map((current) => projectionIndex.toolsByMessageKey.get(messageOwnerKey(current))),
        );
        const thoughts = mergeCanonicalRowsByKey(
          projectionIndex.thoughtsByTurnKey.get(turnKey),
          ...messages.map((current) => projectionIndex.thoughtsByMessageKey.get(messageOwnerKey(current))),
        );
        for (const tool of tools) {
          renderedToolCallIds.add(tool.toolCallId);
        }
        for (const thought of thoughts) {
          renderedThoughtKeys.add(thought.key);
        }
        const entry = buildAssistantEntryForTurn({
          sessionId: state.sessionId,
          turnKey,
          messages,
          tools,
          thoughts,
        });
        if (entry) {
          entries.push(entry);
        }
        continue;
      }
      const tools = resolveAssistantMessageTools(projectionIndex, message);
      const thoughts = resolveAssistantMessageThoughts(projectionIndex, message);
      for (const tool of tools) {
        renderedToolCallIds.add(tool.toolCallId);
      }
      for (const thought of thoughts) {
        renderedThoughtKeys.add(thought.key);
      }
      entries.push(buildAssistantEntry(state.sessionId, message, tools, thoughts));
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
    if (hasExplicitTurnBinding(tool)) {
      const turnKey = toolTurnKey(tool);
      if (!renderedAssistantTurnKeys.has(turnKey)) {
        renderedAssistantTurnKeys.add(turnKey);
        const tools = projectionIndex.toolsByTurnKey.get(turnKey) ?? [tool];
        for (const current of tools) {
          renderedToolCallIds.add(current.toolCallId);
        }
        const thoughts = projectionIndex.thoughtsByTurnKey.get(turnKey) ?? [];
        for (const thought of thoughts) {
          renderedThoughtKeys.add(thought.key);
        }
        const entry = buildAssistantEntryForTurn({
          sessionId: state.sessionId,
          turnKey,
          messages: assistantMessagesByExplicitTurnKey.get(turnKey) ?? [],
          tools,
          thoughts,
        });
        if (entry) {
          entries.push(entry);
        }
      }
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
      ...(tool.updatedAt != null ? { updatedAt: tool.updatedAt } : {}),
      ...(tool.seq != null ? { sequenceId: tool.seq } : {}),
      segments: [buildToolSegment(`tool:${turnKey}:${laneKey}:${tool.toolCallId}`, tool)],
      isStreaming: tool.status === 'running',
    }));
  }
  for (const thought of state.thoughts) {
    if (renderedThoughtKeys.has(thought.key)) {
      continue;
    }
    const thoughtEntry = buildThoughtOnlyAssistantEntry(state, projectionIndex, thought.key);
    if (thoughtEntry) {
      entries.push(thoughtEntry);
      renderedThoughtKeys.add(thought.key);
    }
  }
  return sortTimelineEntries(entries);
}

export function buildTimelineEntriesFromCanonicalState(state: CanonicalSessionState): SessionTimelineEntry[] {
  return buildTimelineEntriesFromProjectionIndex(state, buildStateProjectionIndex(state));
}

function affectedMessageKeysForTool(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  tool: CanonicalToolState,
): Set<string> {
  return findAssistantMessageCanonicalKeysForTool(state, projectionIndex, tool);
}

function affectedTimelineEntryKeysForCanonicalEvents(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  events: readonly CanonicalSessionEvent[],
): Set<string> {
  const affected = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case 'message_part': {
        const messageKey = buildCanonicalMessageStateKey(event);
        const messageIndex = state.messageIndexByKey.get(messageKey);
        const message = messageIndex == null ? undefined : state.messages[messageIndex];
        if (message) {
          const ownerMessageKey = messageOwnerKey(message);
          affected.add(message.key);
          for (const tool of projectionIndex.toolsByMessageKey.get(ownerMessageKey) ?? []) {
            affected.add(tool.key);
          }
          for (const thought of projectionIndex.thoughtsByMessageKey.get(ownerMessageKey) ?? []) {
            affected.add(thought.key);
          }
          for (const tool of projectionIndex.toolsByTurnKey.get(messageTurnKey(message)) ?? []) {
            affected.add(tool.key);
          }
          for (const thought of projectionIndex.thoughtsByTurnKey.get(messageTurnKey(message)) ?? []) {
            affected.add(thought.key);
          }
        }
        break;
      }
      case 'tool': {
        const toolKey = buildCanonicalToolStateKey(event);
        const toolIndex = state.toolIndexByKey.get(toolKey);
        const tool = toolIndex == null ? undefined : state.tools[toolIndex];
        if (!tool) {
          break;
        }
        const affectedMessageCanonicalKeys = findAssistantMessageCanonicalKeysForTool(state, projectionIndex, tool);
        affected.add(tool.key);
        for (const messageKey of affectedMessageCanonicalKeys) {
          affected.add(messageKey);
        }
        break;
      }
      case 'thought': {
        const thoughtKey = `thought:${event.laneKey || 'main'}:${event.thoughtId || event.runId || event.seq || event.eventId}`;
        affected.add(thoughtKey);
        if (event.ownerMessageKey) {
          const ownerMessageIndex = state.messageIndexByMessageKey.get(event.ownerMessageKey);
          const ownerMessage = ownerMessageIndex == null ? undefined : state.messages[ownerMessageIndex];
          if (ownerMessage) {
            affected.add(ownerMessage.key);
          }
        }
        if (event.ownerTurnKey) {
          for (const thought of projectionIndex.thoughtsByTurnKey.get(event.ownerTurnKey) ?? []) {
            affected.add(thought.key);
          }
          for (const tool of projectionIndex.toolsByTurnKey.get(event.ownerTurnKey) ?? []) {
            affected.add(tool.key);
          }
        }
        break;
      }
      case 'team':
        affected.add(`team:${event.eventId}`);
        break;
      default:
        break;
    }
  }
  return affected;
}

function buildThoughtOnlyAssistantEntry(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  canonicalKey: string,
): SessionTimelineEntry | null {
  const thoughtIndex = state.thoughtIndexByKey.get(canonicalKey);
  const thought = thoughtIndex == null ? undefined : state.thoughts[thoughtIndex];
  if (!thought) {
    return null;
  }
  if (thought.ownerMessageKey && state.messageIndexByMessageKey.has(thought.ownerMessageKey)) {
    return null;
  }
  const laneKey = thought.laneKey || 'main';
  const turnKey = thoughtTurnKey(thought);
  const boundThoughts = hasExplicitTurnBinding(thought) && thought.ownerTurnKey
    ? projectionIndex.thoughtsByTurnKey.get(thought.ownerTurnKey) ?? [thought]
    : [thought];
  const identity = thoughtTurnIdentity(thought);
  const status = thought.status === 'streaming' && state.runtime.activeRunId !== thought.runId
    ? 'final'
    : thought.status;
  return buildAssistantTurnEntry({
    identity: {
      sessionKey: state.sessionId,
      ...(thought.runId ? { runId: thought.runId } : {}),
      ...(thought.agentId ? { agentId: thought.agentId } : {}),
      laneKey,
      turnKey,
      turnBindingSource: identity.source,
      turnBindingConfidence: identity.confidence,
      turnIdentityMode: identity.mode,
      turnIdentityConfidence: identity.confidence,
      entryId: `canonical:${thought.key}`,
    },
    status,
    text: '',
    ...(thought.updatedAt != null ? { createdAt: thought.updatedAt } : {}),
    ...(thought.updatedAt != null ? { updatedAt: thought.updatedAt } : {}),
    ...(thought.seq != null ? { sequenceId: thought.seq } : {}),
    segments: boundThoughts
      .filter((current) => current.text.trim())
      .map((current, index) => ({
        kind: 'thinking' as const,
        key: `thinking:${turnKey}:${laneKey}:state-only:${index}`,
        text: current.text.trim(),
      })),
    isStreaming: status === 'streaming',
  });
}

function buildTimelineEntryForCanonicalKey(
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
  canonicalKey: string,
): SessionTimelineEntry | null {
  const messageIndex = state.messageIndexByKey.get(canonicalKey);
  if (messageIndex != null) {
    const message = state.messages[messageIndex];
    if (!message) {
      return null;
    }
    if (message.role === 'assistant') {
      return buildAssistantEntry(
        state.sessionId,
        message,
        resolveAssistantMessageTools(projectionIndex, message),
        resolveAssistantMessageThoughts(projectionIndex, message),
      );
    }
    if (message.role === 'user') {
      return buildUserTimelineEntry(state.sessionId, message);
    }
    return {
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
    };
  }

  const thoughtEntry = buildThoughtOnlyAssistantEntry(state, projectionIndex, canonicalKey);
  if (thoughtEntry) {
    return thoughtEntry;
  }

  const toolIndex = state.toolIndexByKey.get(canonicalKey);
  const tool = toolIndex == null ? undefined : state.tools[toolIndex];
  if (!tool) {
    return null;
  }
  const affectedAssistantMessageCanonicalKeys = affectedMessageKeysForTool(state, projectionIndex, tool);
  if (affectedAssistantMessageCanonicalKeys.size > 0) {
    return null;
  }
  const laneKey = tool.laneKey || 'main';
  const turnKey = toolTurnKey(tool);
  const identity = toolTurnIdentity(tool);
  return buildAssistantTurnEntry({
    identity: {
      sessionKey: state.sessionId,
      ...(tool.runId ? { runId: tool.runId } : {}),
      ...(tool.agentId ? { agentId: tool.agentId } : {}),
      laneKey,
      turnKey,
      turnBindingSource: identity.source,
      turnBindingConfidence: identity.confidence,
      turnIdentityMode: identity.mode,
      turnIdentityConfidence: identity.confidence,
      entryId: `canonical:${tool.key}`,
    },
    status: tool.status === 'running' ? 'streaming' : 'final',
    text: '',
    ...(tool.createdAt != null ? { createdAt: tool.createdAt } : {}),
    ...(tool.updatedAt != null ? { updatedAt: tool.updatedAt } : {}),
    ...(tool.seq != null ? { sequenceId: tool.seq } : {}),
    segments: [buildToolSegment(`tool:${turnKey}:${laneKey}:${tool.toolCallId}`, tool)],
    isStreaming: tool.status === 'running',
  });
}

function replaceTimelineEntries(
  entries: SessionTimelineEntry[],
  affectedCanonicalKeys: ReadonlySet<string>,
  state: CanonicalSessionState,
  projectionIndex: ReturnType<typeof buildStateProjectionIndex>,
): SessionTimelineEntry[] {
  const nextEntries = entries.filter((entry) => {
    const canonicalKey = entry.entryId?.startsWith('canonical:') ? entry.entryId.slice('canonical:'.length) : '';
    return !canonicalKey || !affectedCanonicalKeys.has(canonicalKey);
  });
  for (const canonicalKey of affectedCanonicalKeys) {
    const entry = buildTimelineEntryForCanonicalKey(state, projectionIndex, canonicalKey);
    if (entry) {
      nextEntries.push(entry);
    }
  }
  return sortTimelineEntries(nextEntries);
}

export function buildIncrementalProjectedCanonicalSessionState(input: IncrementalCanonicalSessionProjectionInput): {
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionRenderExecutionGraphItem[];
  renderItems: SessionRenderItem[];
  renderItemIndexByKey: Map<string, number>;
  renderItemKeyIndex: CanonicalProjectionRenderItemKeyIndex;
} {
  const projectionIndex = buildStateProjectionIndex(input.state);
  const affectedCanonicalKeys = affectedTimelineEntryKeysForCanonicalEvents(input.state, projectionIndex, input.committedEvents);
  if (
    affectedCanonicalKeys.size === 0
    || input.committedEvents.some((event) => event.type === 'team' || hasExplicitTurnBinding(event))
  ) {
    return buildProjectedCanonicalSessionState(input.state);
  }
  const timelineEntries = replaceTimelineEntries(input.timelineEntries, affectedCanonicalKeys, input.state, projectionIndex);
  const renderProjection = buildRenderProjectionFromTimeline({
    state: input.state,
    timelineEntries,
    executionGraphItems: input.executionGraphItems,
  });
  return {
    timelineEntries,
    executionGraphItems: input.executionGraphItems,
    renderItems: renderProjection.renderItems,
    renderItemIndexByKey: renderProjection.renderItemIndexByKey,
    renderItemKeyIndex: renderProjection.renderItemKeyIndex,
  };
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

export function buildRenderProjectionFromTimeline(input: {
  state: CanonicalSessionState;
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionRenderExecutionGraphItem[];
}): {
  renderItems: SessionRenderItem[];
  renderItemIndexByKey: Map<string, number>;
  renderItemKeyIndex: CanonicalProjectionRenderItemKeyIndex;
} {
  const renderItems = buildRenderItemsFromTimeline({
    sessionKey: input.state.sessionId,
    timelineEntries: input.timelineEntries,
    executionGraphItems: input.executionGraphItems,
    runtime: input.state.runtime,
  });
  return {
    renderItems,
    renderItemIndexByKey: buildRenderItemIndexByKey(renderItems),
    renderItemKeyIndex: buildProjectionRenderItemKeyIndex({ state: input.state, timelineEntries: input.timelineEntries }),
  };
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
