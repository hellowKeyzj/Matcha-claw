import type { ChatAssistantTurnItem, ChatRenderItem } from './chat-render-item-model';
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
  group: { key: string; tools: SessionRenderToolCard[]; sources: ToolRef[] };
  scopeKey: string;
  canCrossItems: boolean;
  toolIndexByCallId: Map<string, number>;
};

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

function appendTool(builder: ToolGroupBuilder, source: ToolRef): void {
  const callId = source.tool.toolCallId;
  const previousIndex = callId?.trim() ? builder.toolIndexByCallId.get(callId) : undefined;
  if (previousIndex !== undefined) {
    builder.group.tools[previousIndex] = source.tool;
  } else {
    if (callId?.trim()) builder.toolIndexByCallId.set(callId, builder.group.tools.length);
    builder.group.tools.push(source.tool);
  }
  builder.group.sources.push(source);
}

function isSameToolGroup(left: ToolGroup, right: ToolGroup): boolean {
  return left.key === right.key
    && left.tools.length === right.tools.length
    && left.tools.every((tool, index) => tool === right.tools[index])
    && left.sources.length === right.sources.length
    && left.sources.every((source, index) => {
      const other = right.sources[index];
      return source.itemKey === other.itemKey && source.segmentKey === other.segmentKey && source.tool === other.tool;
    });
}

export function buildToolGroupPlan(items: ReadonlyArray<ChatRenderItem>, previousPlan?: ToolGroupPlan): ToolGroupPlan {
  const plan = new Map<string, ReadonlyMap<string, ToolSlot>>();
  let previousTail: ToolGroupBuilder | undefined;

  for (const item of items) {
    if (item.kind !== 'assistant-turn') {
      previousTail = undefined;
      continue;
    }

    const slots = new Map<string, ToolSlot>();
    const groups: ToolGroupBuilder[] = [];
    let current: ToolGroupBuilder | undefined;
    let toolOnly = hasOnlyToolItemContent(item) && item.segments.length > 0;
    for (const segment of item.segments) {
      if (segment.kind !== 'tool'
        || (segment.tool.result.kind === 'canvas' && segment.tool.result.surface === 'assistant-bubble')) {
        current = undefined;
        toolOnly = false;
        continue;
      }

      const tool = segment.tool;
      const toolRunId = tool.runId?.trim() ? tool.runId : undefined;
      const itemRunId = item.runId?.trim() ? item.runId : undefined;
      const runConflict = !!toolRunId && !!itemRunId && toolRunId !== itemRunId;
      const resolvedRunId = toolRunId ?? itemRunId ?? '';
      const scopeKey = JSON.stringify([item.sessionKey, tool.runtimeAdapterId ?? '', resolvedRunId, item.laneKey ?? '', item.agentId ?? '']);
      if (!current || current.scopeKey !== scopeKey || runConflict) {
        current = {
          group: { key: JSON.stringify([scopeKey, tool.toolCallId || tool.id]), tools: [], sources: [] },
          scopeKey,
          canCrossItems: !runConflict && !!resolvedRunId && !!tool.runtimeAdapterId,
          toolIndexByCallId: new Map(),
        };
        groups.push(current);
      }
      appendTool(current, { itemKey: item.key, segmentKey: segment.key, tool });
      if (runConflict) current = undefined;
    }

    let tail: ToolGroupBuilder | undefined;
    for (const [index, builder] of groups.entries()) {
      const joined = index === 0 && toolOnly && previousTail?.canCrossItems && builder.canCrossItems
        && previousTail.scopeKey === builder.scopeKey ? previousTail : undefined;
      for (const [sourceIndex, source] of builder.group.sources.entries()) {
        slots.set(source.segmentKey, joined || sourceIndex > 0
          ? { kind: 'covered', groupKey: (joined ?? builder).group.key }
          : { kind: 'head', group: builder.group });
        if (joined) appendTool(joined, source);
      }
      tail = joined ?? builder;
    }
    if (slots.size > 0) plan.set(item.key, slots);
    previousTail = toolOnly ? tail : undefined;
  }

  for (const [itemKey, slots] of plan) {
    const previousSlots = previousPlan?.get(itemKey);
    if (!previousSlots) continue;
    const sharedSlots = new Map<string, ToolSlot>();
    let unchanged = slots.size === previousSlots.size;
    for (const [segmentKey, slot] of slots) {
      const previousSlot = previousSlots.get(segmentKey);
      const sameSlot = slot.kind === 'head'
        ? previousSlot?.kind === 'head' && isSameToolGroup(slot.group, previousSlot.group)
        : previousSlot?.kind === 'covered' && slot.groupKey === previousSlot.groupKey;
      sharedSlots.set(segmentKey, sameSlot && previousSlot ? previousSlot : slot);
      if (!sameSlot) unchanged = false;
    }
    plan.set(itemKey, unchanged ? previousSlots : sharedSlots);
  }
  return plan;
}
