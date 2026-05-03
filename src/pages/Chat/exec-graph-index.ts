import {
  canAppendReferenceList,
  isRenderableTimelineEntry,
  resolveTimelineEntryRowKey,
} from './chat-row-model';
import { parseSubagentCompletionInfo } from './task-viz';
import type {
  AnchorsSnapshot,
  CompletionEventAnchor,
  MessageKeyIndexSnapshot,
} from './exec-graph-types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

export function buildMessageKeyIndex(
  sessionKey: string,
  timelineEntries: SessionTimelineEntry[],
  previous?: MessageKeyIndexSnapshot,
): MessageKeyIndexSnapshot {
  if (previous && canAppendReferenceList(previous.timelineEntriesRef, timelineEntries)) {
    const keyByIndex = new Map(previous.keyByIndex);
    let renderableCount = previous.renderableCount;
    for (let index = previous.timelineEntriesRef.length; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!isRenderableTimelineEntry(entry)) {
        continue;
      }
      keyByIndex.set(index, resolveTimelineEntryRowKey(sessionKey, entry));
      renderableCount += 1;
    }
    return {
      timelineEntriesRef: timelineEntries,
      keyByIndex,
      renderableCount,
    };
  }

  const keyByIndex = new Map<number, string>();
  let renderableCount = 0;
  for (const [index, entry] of timelineEntries.entries()) {
    if (!isRenderableTimelineEntry(entry)) {
      continue;
    }
    keyByIndex.set(index, resolveTimelineEntryRowKey(sessionKey, entry));
    renderableCount += 1;
  }
  return {
    timelineEntriesRef: timelineEntries,
    keyByIndex,
    renderableCount,
  };
}

function findCompletionEventAnchors(
  timelineEntries: SessionTimelineEntry[],
): CompletionEventAnchor[] {
  const anchors: CompletionEventAnchor[] = [];
  for (const [eventIndex, entry] of timelineEntries.entries()) {
    const completionInfo = parseSubagentCompletionInfo(entry);
    if (!completionInfo) {
      continue;
    }

    let triggerIndex = eventIndex;
    for (let index = eventIndex - 1; index >= 0; index -= 1) {
      const previousEntry = timelineEntries[index];
      if (previousEntry.role !== 'user') {
        continue;
      }
      if (parseSubagentCompletionInfo(previousEntry)) {
        continue;
      }
      triggerIndex = index;
      break;
    }

    let replyIndex: number | null = null;
    for (let index = eventIndex + 1; index < timelineEntries.length; index += 1) {
      if (timelineEntries[index]?.role === 'assistant') {
        replyIndex = index;
        break;
      }
    }

    anchors.push({
      eventIndex,
      triggerIndex,
      replyIndex,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    });
  }
  return anchors;
}

export function buildCompletionAnchors(
  timelineEntries: SessionTimelineEntry[],
  previous?: AnchorsSnapshot,
): AnchorsSnapshot {
  if (!previous || !canAppendReferenceList(previous.timelineEntriesRef, timelineEntries)) {
    return {
      timelineEntriesRef: timelineEntries,
      anchors: findCompletionEventAnchors(timelineEntries),
    };
  }

  const anchors = previous.anchors.map((anchor) => ({ ...anchor }));
  const unresolvedIndices: number[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].replyIndex == null) {
      unresolvedIndices.push(index);
    }
  }

  for (let index = previous.timelineEntriesRef.length; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];

    if (entry.role === 'assistant') {
      while (unresolvedIndices.length > 0) {
        const unresolvedIndex = unresolvedIndices[0];
        if (anchors[unresolvedIndex].eventIndex < index) {
          anchors[unresolvedIndex].replyIndex = index;
          unresolvedIndices.shift();
          break;
        }
        break;
      }
    }

    const completionInfo = parseSubagentCompletionInfo(entry);
    if (!completionInfo) {
      continue;
    }

    let triggerIndex = index;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previousEntry = timelineEntries[cursor];
      if (previousEntry.role !== 'user') {
        continue;
      }
      if (parseSubagentCompletionInfo(previousEntry)) {
        continue;
      }
      triggerIndex = cursor;
      break;
    }

    anchors.push({
      eventIndex: index,
      triggerIndex,
      replyIndex: null,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    });
    unresolvedIndices.push(anchors.length - 1);
  }

  return {
    timelineEntriesRef: timelineEntries,
    anchors,
  };
}
