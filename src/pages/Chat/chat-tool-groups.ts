import type { ChatAssistantTurnItem, ChatRenderItem } from './chat-render-item-model';
import { isControlledSessionRenderTool } from '@/stores/chat/session-render-projection';
import type { SessionRenderToolCard } from '../../types/session/tool-card';
import type { SessionIdentity } from '../../types/desktop/runtime-address';
import { isOpenClawSurfaceSessionIdentity } from '../../types/openclaw-runtime-surface';
import { isOpenClawTool, readBrowserTabPreview } from './tool-renderers/openclaw-details';

export interface ToolRef {
  readonly itemKey: string;
  readonly segmentKey: string;
  readonly tool: SessionRenderToolCard;
}

export interface ToolGroup {
  readonly key: string;
  readonly tools: ReadonlyArray<SessionRenderToolCard>;
  readonly sources: ReadonlyArray<ToolRef>;
}

export type ToolSlot =
  | { readonly kind: 'head'; readonly group: ToolGroup }
  | { readonly kind: 'covered'; readonly groupKey: string };

export type ToolGroupPlan = ReadonlyMap<string, ReadonlyMap<string, ToolSlot>>;

type ToolGroupBuilder = {
  key: string;
  scopeKey: string;
  canCrossItems: boolean;
  previous?: ToolGroup;
  previousCallIds?: ReadonlyArray<string | undefined>;
  sourceCount: number;
  sources?: ToolRef[];
  callIds?: (string | undefined)[];
  group?: ToolGroup;
};
type ToolItemSlots = {
  itemKey: string;
  entries: { segmentKey: string; builder: ToolGroupBuilder; head: boolean }[];
};

// Only scalar grouping inputs are retained. Mutable payloads are never cached here.
const groupCallIds = new WeakMap<ToolGroup, ReadonlyArray<string | undefined>>();

export function getToolDisclosureKey(tool: SessionRenderToolCard): string {
  return `tool:${tool.runtimeAdapterId ?? ''}:${tool.runId ?? ''}:${tool.toolCallId || tool.id}`;
}

export function getToolGroupDisclosureKey(groupKey: string): string {
  return `group:${groupKey}`;
}

export function selectLatestBrowserTools(items: ReadonlyArray<ChatRenderItem>, sessionIdentity?: SessionIdentity): ReadonlySet<SessionRenderToolCard> {
  const latest = new Map<string, SessionRenderToolCard>();
  if (!isOpenClawSurfaceSessionIdentity(sessionIdentity)) return new Set();
  for (const item of items) {
    if (item.kind !== 'assistant-turn' || item.sessionKey !== sessionIdentity.sessionKey
      || (item.agentId !== undefined && item.agentId !== sessionIdentity.agentId)) continue;
    for (const segment of item.segments) {
      if (segment.kind !== 'tool' || !isOpenClawTool(segment.tool) || segment.tool.name !== 'browser') continue;
      const tab = readBrowserTabPreview(segment.tool.details);
      if (tab) {
        latest.set(JSON.stringify([tab.target, tab.node ?? '', tab.profile, tab.targetId]), segment.tool);
        continue;
      }
      const input = segment.tool.input;
      const params = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
      const request = params?.action === 'act' && params.request && typeof params.request === 'object' && !Array.isArray(params.request)
        ? params.request as Record<string, unknown> : undefined;
      const requestedTargetId = request?.targetId ?? params?.targetId;
      const targetId = typeof requestedTargetId === 'string' ? requestedTargetId.trim() : undefined;
      const target = typeof params?.target === 'string' ? params.target.trim() : undefined;
      const profile = typeof params?.profile === 'string' ? params.profile.trim() : undefined;
      // Input only invalidates older captures; omitted routes and node selectors are not resolved native addresses.
      for (const [key, candidate] of latest) {
        const previous = readBrowserTabPreview(candidate.details)!;
        if ((target === 'host' || target === 'node') && target !== previous.target) continue;
        if (profile && profile !== previous.profile) continue;
        if (targetId && targetId !== previous.targetId) continue;
        latest.delete(key);
      }
    }
  }
  return new Set(latest.values());
}

function hasOnlyToolItemContent(item: ChatAssistantTurnItem): boolean {
  return item.text.length === 0
    && item.thinking === null
    && item.images.length === 0
    && item.attachedFiles.length === 0
    && !item.embeddedToolResults?.length
    && item.pendingState == null
    && item.pendingLabel == null;
}

export function isCoveredToolOnlyItem(
  item: ChatAssistantTurnItem,
  toolSlots: ReadonlyMap<string, ToolSlot> | undefined,
): boolean {
  return hasOnlyToolItemContent(item)
    && item.segments.length > 0
    && item.segments.every((segment) => segment.kind === 'tool' && toolSlots?.get(segment.key)?.kind === 'covered');
}

function appendTool(builder: ToolGroupBuilder, item: ChatAssistantTurnItem, segmentKey: string, tool: SessionRenderToolCard): void {
  const index = builder.sourceCount++;
  const previousSource = builder.previous?.sources[index];
  if (isControlledSessionRenderTool(tool) && !builder.sources && previousSource
    && previousSource.itemKey === item.key && previousSource.segmentKey === segmentKey && previousSource.tool === tool
    && builder.previousCallIds?.[index] === tool.toolCallId) return;
  if (!builder.sources) {
    builder.sources = builder.previous?.sources.slice(0, index) ?? [];
    builder.callIds = builder.previousCallIds?.slice(0, index) ?? [];
  }
  builder.sources.push({ itemKey: item.key, segmentKey, tool });
  builder.callIds!.push(tool.toolCallId);
}

function finishToolGroup(builder: ToolGroupBuilder | undefined): void {
  if (!builder || builder.group) return;
  if (!builder.sources && builder.sourceCount === builder.previous?.sources.length) {
    builder.group = builder.previous;
    return;
  }
  const sources = builder.sources ?? builder.previous!.sources.slice(0, builder.sourceCount);
  const callIds = builder.callIds ?? builder.previousCallIds!.slice(0, builder.sourceCount);
  const tools: SessionRenderToolCard[] = [];
  const toolIndexByCallId = new Map<string, number>();
  for (const source of sources) {
    const callId = source.tool.toolCallId;
    const previousIndex = callId?.trim() ? toolIndexByCallId.get(callId) : undefined;
    if (previousIndex !== undefined) tools[previousIndex] = source.tool;
    else {
      if (callId?.trim()) toolIndexByCallId.set(callId, tools.length);
      tools.push(source.tool);
    }
  }
  builder.group = { key: builder.key, tools, sources };
  groupCallIds.set(builder.group, callIds);
}

function resolveItemSlots(item: ToolItemSlots, previousSlots: ReadonlyMap<string, ToolSlot> | undefined): ReadonlyMap<string, ToolSlot> {
  let slots = item.entries.length === previousSlots?.size ? undefined : new Map<string, ToolSlot>();
  for (let index = 0; index < item.entries.length; index += 1) {
    const { segmentKey, builder, head } = item.entries[index];
    const previousSlot = previousSlots?.get(segmentKey);
    const sameSlot = head
      ? previousSlot?.kind === 'head' && previousSlot.group === builder.group
      : previousSlot?.kind === 'covered' && previousSlot.groupKey === builder.key;
    if (!sameSlot && !slots) {
      slots = new Map(item.entries.slice(0, index).map((entry) => [entry.segmentKey, previousSlots!.get(entry.segmentKey)!]));
    }
    slots?.set(segmentKey, sameSlot ? previousSlot! : head
      ? { kind: 'head', group: builder.group! }
      : { kind: 'covered', groupKey: builder.key });
  }
  return slots ?? previousSlots!;
}

export function buildToolGroupPlan(items: ReadonlyArray<ChatRenderItem>, previousPlan?: ToolGroupPlan): ToolGroupPlan {
  const itemSlots: ToolItemSlots[] = [];
  let previousTail: ToolGroupBuilder | undefined;

  for (const item of items) {
    if (item.kind !== 'assistant-turn') {
      finishToolGroup(previousTail);
      previousTail = undefined;
      continue;
    }
    const slots: ToolItemSlots = { itemKey: item.key, entries: [] };
    const toolOnly = hasOnlyToolItemContent(item) && item.segments.length > 0
      && item.segments.every((segment) => segment.kind === 'tool'
        && !(segment.tool.result.kind === 'canvas' && segment.tool.result.surface === 'assistant-bubble'));
    if (!toolOnly || !previousTail?.canCrossItems) {
      finishToolGroup(previousTail);
      previousTail = undefined;
    }
    let current = previousTail;
    for (const segment of item.segments) {
      if (segment.kind !== 'tool'
        || (segment.tool.result.kind === 'canvas' && segment.tool.result.surface === 'assistant-bubble')) {
        finishToolGroup(current);
        current = undefined;
        continue;
      }
      const tool = segment.tool;
      const toolRunId = tool.runId?.trim() ? tool.runId : undefined;
      const itemRunId = item.runId?.trim() ? item.runId : undefined;
      const runConflict = !!toolRunId && !!itemRunId && toolRunId !== itemRunId;
      const resolvedRunId = toolRunId ?? itemRunId ?? '';
      const scopeKey = JSON.stringify([item.sessionKey, tool.runtimeAdapterId ?? '', resolvedRunId, item.laneKey ?? '', item.agentId ?? '']);
      if (!current || current.scopeKey !== scopeKey || runConflict) {
        finishToolGroup(current);
        const key = JSON.stringify([scopeKey, tool.toolCallId || tool.id]);
        const previousSlot = previousPlan?.get(item.key)?.get(segment.key);
        const previous = previousSlot?.kind === 'head' && previousSlot.group.key === key ? previousSlot.group : undefined;
        const previousCallIds = previous && groupCallIds.get(previous);
        current = {
          key, scopeKey, canCrossItems: !runConflict && !!resolvedRunId && !!tool.runtimeAdapterId,
          previous: previousCallIds ? previous : undefined, previousCallIds, sourceCount: 0,
        };
      }
      slots.entries.push({ segmentKey: segment.key, builder: current, head: current.sourceCount === 0 });
      appendTool(current, item, segment.key, tool);
      if (runConflict) {
        finishToolGroup(current);
        current = undefined;
      }
    }
    if (slots.entries.length > 0) itemSlots.push(slots);
    if (!toolOnly) finishToolGroup(current);
    previousTail = toolOnly ? current : undefined;
  }
  finishToolGroup(previousTail);

  const plan = new Map<string, ReadonlyMap<string, ToolSlot>>();
  for (const slots of itemSlots) plan.set(slots.itemKey, resolveItemSlots(slots, previousPlan?.get(slots.itemKey)));
  return plan;
}
