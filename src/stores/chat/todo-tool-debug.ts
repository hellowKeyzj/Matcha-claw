import { logRendererDebug } from '@/lib/debug-logging';
import type {
  SessionAssistantTurnItem,
  SessionRenderItem,
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';

const TODO_TOOL_DEBUG_PATTERN = /TodoWrite|TodoGet|todowrite|todoget|newTodos|oldTodos/;

function safeDebugStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function containsTodoToolDebugSignal(value: unknown): boolean {
  return TODO_TOOL_DEBUG_PATTERN.test(safeDebugStringify(value));
}

export function summarizeAssistantTurnForTodoToolDebug(
  item: SessionAssistantTurnItem,
): Record<string, unknown> {
  return {
    key: item.key,
    status: item.status,
    runId: item.runId,
    turnKey: item.turnKey,
    toolCount: item.tools.length,
    tools: item.tools.map((tool) => ({
      id: tool.id,
      toolCallId: tool.toolCallId,
      name: tool.name,
      status: tool.status,
      displayTitle: tool.displayTitle,
      displayDetail: tool.displayDetail,
      inputText: tool.inputText,
    })),
    segments: item.segments.map((segment) => {
      if (segment.kind !== 'tool') {
        return { kind: segment.kind, key: segment.key };
      }
      return {
        kind: 'tool',
        key: segment.key,
        tool: {
          id: segment.tool.id,
          toolCallId: segment.tool.toolCallId,
          name: segment.tool.name,
          status: segment.tool.status,
          displayTitle: segment.tool.displayTitle,
          displayDetail: segment.tool.displayDetail,
          inputText: segment.tool.inputText,
        },
      };
    }),
  };
}

export function summarizeItemsForTodoToolDebug(
  items: readonly SessionRenderItem[],
): Array<Record<string, unknown>> {
  return items.map((item) => {
    if (item.kind !== 'assistant-turn') {
      return {
        key: item.key,
        kind: item.kind,
        role: item.role,
      };
    }
    return {
      key: item.key,
      kind: item.kind,
      ...summarizeAssistantTurnForTodoToolDebug(item),
    };
  });
}

export function summarizeSnapshotForTodoToolDebug(
  snapshot: SessionStateSnapshot,
): Record<string, unknown> {
  return {
    sessionKey: snapshot.sessionKey,
    itemCount: snapshot.items.length,
    taskSnapshot: snapshot.taskSnapshot
      ? {
          source: snapshot.taskSnapshot.source,
          tasksCount: snapshot.taskSnapshot.tasks.length,
          todosCount: snapshot.taskSnapshot.todos?.length ?? 0,
          todos: snapshot.taskSnapshot.todos ?? [],
        }
      : null,
    items: summarizeItemsForTodoToolDebug(snapshot.items),
  };
}

export function logRendererTodoToolDebug(stage: string, payload: unknown): void {
  if (!containsTodoToolDebugSignal(payload)) {
    return;
  }
  logRendererDebug(`[todo-tool-debug] ${stage}`, payload);
}
