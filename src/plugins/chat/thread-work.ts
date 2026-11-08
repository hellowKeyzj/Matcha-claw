import type { ReplyTiming } from './reply-timing';
import type { ThreadItemPresentation } from './thread-presentation';
import type { SessionAssistantTurnSegment, SessionRenderToolCard } from '@/types/session/tool-card';
import { readBrowserTabPreview, readMcpAppPreview } from '@/plugins/message-rendering/tool-renderers/openclaw-details';

/** Renderer-only grouping; neither this key nor its segments define a native run. */
export interface ThreadWorkPresentation {
  key: string;
  segmentKeys: ReadonlySet<string>;
  headSegmentKey?: string;
  toolCount: number;
  timing?: ReplyTiming;
}

function preservesToolResult(tool: SessionRenderToolCard): boolean {
  return tool.result.kind === 'canvas' || !!readMcpAppPreview(tool.details) || !!readBrowserTabPreview(tool.details);
}

function collapseInterval(
  rows: readonly ThreadItemPresentation[],
  start: number,
  end: number,
  plan: Map<string, ThreadWorkPresentation>,
  previous?: ReadonlyMap<string, ThreadWorkPresentation>,
): void {
  const parts: { row: ThreadItemPresentation; segment: SessionAssistantTurnSegment; visible: boolean; protected: boolean }[] = [];
  let timing: ReplyTiming | undefined;
  let lastReply = -1;
  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    const { item, view } = row;
    if (item.kind !== 'assistant-turn') continue;
    if (item.status === 'streaming' || item.status === 'waiting_tool' || item.pendingState || view?.pendingMode) return;
    if (row.timing?.kind === 'finished') timing = row.timing;
    const visibleKeys = new Set(row.visible ? view?.segments.map((segment) => segment.key) : []);
    for (const segment of item.segments) {
      const slot = row.toolSlots?.get(segment.key);
      const tools = segment.kind === 'tool' ? slot?.kind === 'head' ? slot.group.tools : [segment.tool] : [];
      if (tools.some((tool) => tool.status === 'running' || tool.status === 'missing_result' || tool.status === 'unknown')) return;
      const visible = visibleKeys.has(segment.key);
      // Hidden thinking and covered tools still delimit the continuous answer.
      if (!visible && segment.kind !== 'thinking' && segment.kind !== 'tool') continue;
      parts.push({ row, segment, visible, protected: segment.kind === 'media' || tools.some(preservesToolResult) });
      if (visible && (segment.kind === 'message' || segment.kind === 'media')) lastReply = parts.length - 1;
    }
  }
  if (lastReply < 0) return;

  // Keep all answer segments after the last preceding activity, not tools after the answer.
  let lastActivity = lastReply - 1;
  while (lastActivity >= 0 && parts[lastActivity].segment.kind !== 'tool' && parts[lastActivity].segment.kind !== 'thinking') lastActivity -= 1;
  if (lastActivity < 0) return;
  let first = lastActivity;
  while (first >= 0 && !parts[first].protected) first -= 1;
  first += 1;
  const answer = parts[lastActivity + 1];
  const key = JSON.stringify(['work', answer.row.item.sessionKey, answer.row.item.key, answer.segment.key]);
  const keysByItem = new Map<string, string[]>();
  const toolIds = new Set<string>();
  let head: typeof parts[number] | undefined;
  for (let index = first; index <= lastActivity; index += 1) {
    const part = parts[index];
    const { row, segment } = part;
    if (!part.visible) continue;
    head ??= part;
    let keys = keysByItem.get(row.item.key);
    if (!keys) { keys = []; keysByItem.set(row.item.key, keys); }
    keys.push(segment.key);
    if (segment.kind !== 'tool') continue;
    const slot = row.toolSlots?.get(segment.key);
    for (const tool of slot?.kind === 'head' ? slot.group.tools : [segment.tool]) toolIds.add(tool.toolCallId || tool.id);
  }
  if (!head) return;
  for (const [itemKey, keys] of keysByItem) {
    const old = previous?.get(itemKey);
    const segmentKeys = old?.segmentKeys.size === keys.length && keys.every((key) => old.segmentKeys.has(key))
      ? old.segmentKeys : new Set(keys);
    const headSegmentKey = itemKey === head.row.item.key ? head.segment.key : undefined;
    const sameTiming = old?.timing === timing || old?.timing?.kind === 'finished' && timing?.kind === 'finished'
      && old.timing.startedAtMs === timing.startedAtMs && old.timing.endedAtMs === timing.endedAtMs;
    plan.set(itemKey, old && old.key === key && old.segmentKeys === segmentKeys
      && old.headSegmentKey === headSegmentKey && old.toolCount === toolIds.size && sameTiming ? old
      : { key, segmentKeys, toolCount: toolIds.size, ...(timing ? { timing } : {}),
        ...(headSegmentKey ? { headSegmentKey } : {}),
      });
  }
}

/** Collapse completed presentation groups, without inferring a native reply outcome. */
export function buildThreadWorkPlan(
  rows: readonly ThreadItemPresentation[],
  runWorking: boolean,
  previous?: ReadonlyMap<string, ThreadWorkPresentation>,
): ReadonlyMap<string, ThreadWorkPresentation> {
  const plan = new Map<string, ThreadWorkPresentation>();
  let start = 0;
  for (let index = 1; index <= rows.length; index += 1) {
    if (index < rows.length && rows[index].replyGroupKey === rows[start].replyGroupKey) continue;
    if (rows[start].replyGroupKey !== null && !(runWorking && index === rows.length)) {
      collapseInterval(rows, start, index, plan, previous);
    }
    start = index;
  }
  if (previous?.size === plan.size && [...plan].every(([itemKey, work]) => previous.get(itemKey) === work)) return previous;
  return plan;
}
