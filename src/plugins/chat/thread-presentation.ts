import type { ChatRenderItem } from '@/plugins/message-rendering/chat-render-item-model';
import { hasVisibleUserOutput } from '@/plugins/message-rendering/chat-message-view';
import type { MessageAvatarSlot } from '@/plugins/message-rendering/chat-message-shell';
import { getAssistantBlockSpacing } from '@/plugins/message-rendering/message-layout-tokens';
import type { ToolGroupPlan, ToolSlot } from '@/plugins/message-rendering/tool-groups';
import type { SessionRunTiming } from '@/types/session/snapshot';
import type { SessionTextModel } from './store/session-presentation';
import { buildAssistantTurnView } from './assistant-turn-view';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import type { ReplyTiming } from './reply-timing';

type AssistantView = ReturnType<typeof buildAssistantTurnView>;

type ReplyInput = { messageId?: string; sessionKey: string; groups: Set<ReplyGroup> };
type ReplyGroup = {
  key: string | null;
  rows: ThreadRow[];
  input?: ReplyInput;
  sessionKey?: string;
  laneKey?: string;
  agentId?: string;
};

interface ThreadRow {
  item: ChatRenderItem;
  toolSlots?: ReadonlyMap<string, ToolSlot>;
  view: AssistantView | null;
  visible: boolean;
}

export interface ThreadItemPresentation {
  item: ChatRenderItem;
  toolSlots?: ReadonlyMap<string, ToolSlot>;
  view: AssistantView | null;
  /** Renderer-only continuous reply identity; null is an incomplete history prefix. */
  replyGroupKey: string | null;
  inputMessageId?: string;
  visible: boolean;
  assistantAvatarSlot: MessageAvatarSlot;
  timing?: ReplyTiming;
  spacing: string;
  footer: string | null;
}

function isReplyBoundary(item: ChatRenderItem): boolean {
  return item.kind === 'user-message' || item.kind === 'system';
}

export function buildThreadPresentation(
  items: ReadonlyArray<ChatRenderItem>,
  showThinking: boolean,
  textModel: SessionTextModel,
  toolPlan: ToolGroupPlan,
  previous?: { rows: ReadonlyArray<ThreadItemPresentation>; showThinking: boolean; textModel: SessionTextModel },
  runTimings: readonly SessionRunTiming[] = [],
  activeRunId?: string | null,
): ThreadItemPresentation[] {
  const reusableRows = previous?.showThinking === showThinking && previous.textModel === textModel ? previous.rows : [];
  const previousByKey = new Map(reusableRows.map((row) => [row.item.key, row]));
  const timingByRun = new Map(runTimings.map((timing) => [timing.runId, timing]));
  const timingsByInput = new Map<string, SessionRunTiming[]>();
  for (const timing of runTimings) {
    if (!timing.inputMessageId) continue;
    const timings = timingsByInput.get(timing.inputMessageId);
    if (timings) timings.push(timing);
    else timingsByInput.set(timing.inputMessageId, [timing]);
  }
  const groups: ReplyGroup[] = [];
  const runGroups = new Map<string, Set<ReplyGroup>>();
  let group: ReplyGroup | undefined;
  let input: ReplyInput | undefined;
  let hasBoundary = false;
  let afterGraph = false;

  for (const item of items) {
    const toolSlots = toolPlan.get(item.key);
    const previous = previousByKey.get(item.key);
    const view = previous?.item === item && previous.toolSlots === toolSlots
      ? previous.view
      : item.kind === 'assistant-turn' ? buildAssistantTurnView(item, showThinking, textModel.assistant, toolSlots) : null;
    const visible = view ? view.visible : item.kind === 'user-message'
      ? hasVisibleUserOutput(item) : item.kind !== 'system' || !!item.notice || !!item.text.trim();
    const row: ThreadRow = { item, toolSlots, view, visible };
    const boundary = visible && isReplyBoundary(item);
    if (boundary) {
      hasBoundary = true;
      input = item.kind === 'user-message' ? { messageId: item.messageId, sessionKey: item.sessionKey, groups: new Set() } : undefined;
    }
    const assistant = item.kind === 'assistant-turn';
    const conflict = assistant && group && (item.sessionKey !== group.sessionKey
      || !!group.laneKey && !!item.laneKey && item.laneKey !== group.laneKey
      || !!group.agentId && !!item.agentId && item.agentId !== group.agentId);
    if (!group || boundary || item.kind === 'execution-graph' || assistant && (afterGraph || conflict)) {
      group = {
        key: hasBoundary ? JSON.stringify(['reply', item.sessionKey, item.key]) : null,
        rows: [], input, sessionKey: item.sessionKey,
      };
      groups.push(group);
    }
    group.rows.push(row);
    if (assistant) {
      group.laneKey ??= item.laneKey;
      group.agentId ??= item.agentId;
      input?.groups.add(group);
      const runIds = [item.runId, ...item.segments.flatMap((segment) => segment.kind === 'tool' ? [segment.tool.runId] : [])];
      for (const runId of runIds) {
        if (!runId) continue;
        const owners = runGroups.get(runId);
        if (owners) owners.add(group);
        else runGroups.set(runId, new Set([group]));
      }
      afterGraph = false;
    } else if (item.kind === 'execution-graph') afterGraph = true;
    else if (boundary) afterGraph = false;
  }

  let hasPreviousGroup = false;
  return groups.flatMap((group) => {
    const { rows, input } = group;
    const nativeInputTimings = input?.messageId ? timingsByInput.get(input.messageId) ?? [] : [];
    const inputMessageId = input?.groups.size === 1 && input.sessionKey === group.sessionKey
      && nativeInputTimings.every((timing) => {
        const owners = runGroups.get(timing.runId);
        return !owners || owners.size === 1 && owners.has(group);
      }) ? input.messageId : undefined;
    const inputTimings = inputMessageId ? nativeInputTimings : [];
    const replyRuns = new Set<string>();
    let needsInputTiming = false;
    for (const { item } of rows) {
      if (item.kind !== 'assistant-turn') continue;
      if (item.runId) replyRuns.add(item.runId);
      let rowHasRun = !!item.runId;
      for (const segment of item.segments) {
        if (segment.kind === 'tool' && segment.tool.runId) {
          replyRuns.add(segment.tool.runId);
          rowHasRun = true;
        }
      }
      if (!rowHasRun) needsInputTiming = true;
    }
    if (needsInputTiming) for (const timing of inputTimings) replyRuns.add(timing.runId);
    let complete = !needsInputTiming || inputTimings.length > 0;
    let startedAtMs = Infinity;
    let endedAtMs: number | null = 0;
    for (const runId of replyRuns) {
      const timing = timingByRun.get(runId);
      if (!timing) { complete = false; break; }
      startedAtMs = Math.min(startedAtMs, timing.startedAtMs);
      endedAtMs = endedAtMs === null || timing.endedAtMs === null ? null : Math.max(endedAtMs, timing.endedAtMs);
    }
    const visibleRows = rows.filter((row) => row.visible);
    const assistantRows = visibleRows.filter((row) => row.item.kind === 'assistant-turn');
    const firstAssistant = assistantRows[0];
    const lastAssistant = assistantRows.at(-1);
    const text = assistantRows.flatMap((row) => row.view?.plainText ? [row.view.plainText] : []).join('\n\n');
    let timing: ReplyTiming | undefined = !complete || !replyRuns.size ? undefined
      : activeRunId && replyRuns.has(activeRunId) ? { kind: 'running', startedAtMs }
      : endedAtMs !== null ? { kind: 'finished', startedAtMs, endedAtMs } : undefined;
    const previousTiming = lastAssistant && previousByKey.get(lastAssistant.item.key)?.timing;
    if (timing && previousTiming?.kind === timing.kind && previousTiming.startedAtMs === timing.startedAtMs
      && (timing.kind === 'running' || previousTiming.kind === 'finished' && previousTiming.endedAtMs === timing.endedAtMs)) timing = previousTiming;
    let previousVisible: ThreadRow | undefined;
    const presentations = rows.map((row): ThreadItemPresentation => {
      let spacing = 'w-full';
      if (row.visible) {
        spacing = previousVisible && !isReplyBoundary(previousVisible.item)
          ? `w-full ${getAssistantBlockSpacing(previousVisible.view?.segments.at(-1)?.kind, row.view?.segments[0]?.kind)}`
          : previousVisible || hasPreviousGroup ? CHAT_LAYOUT_TOKENS.threadMessageRowSpacing : 'w-full';
        previousVisible = row;
      }
      return {
        item: row.item, toolSlots: row.toolSlots, view: row.view, replyGroupKey: group.key, inputMessageId,
        visible: row.visible, timing: row === lastAssistant ? timing : undefined, spacing,
        assistantAvatarSlot: row === firstAssistant ? 'visible' : 'placeholder',
        footer: row === lastAssistant ? text : null,
      };
    });
    if (visibleRows.length) hasPreviousGroup = true;
    return presentations;
  });
}
