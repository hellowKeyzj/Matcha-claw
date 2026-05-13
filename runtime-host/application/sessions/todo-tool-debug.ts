import type {
  SessionRenderItem,
  SessionStateSnapshot,
  SessionUpdateEvent,
} from '../../shared/session-adapter-types';
import type { RuntimeHostLogger } from '../../shared/logger';

const TODO_TOOL_DEBUG_PATTERN = /TodoWrite|TodoGet|todowrite|todoget|newTodos|oldTodos/;
const TODO_TOOL_DEBUG_TRACE_LEVEL = 4;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function containsTodoToolDebugSignal(value: unknown): boolean {
  return TODO_TOOL_DEBUG_PATTERN.test(safeStringify(value));
}

function summarizeItem(item: SessionRenderItem | null | undefined): Record<string, unknown> | null {
  if (!item) {
    return null;
  }
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
    status: item.status,
    runId: item.runId,
    turnKey: item.turnKey,
    laneKey: item.laneKey,
    text: item.text,
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

function summarizeSnapshot(snapshot: SessionStateSnapshot | undefined): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }
  return {
    sessionKey: snapshot.sessionKey,
    itemCount: snapshot.items.length,
    window: snapshot.window,
    taskSnapshot: snapshot.taskSnapshot
      ? {
          source: snapshot.taskSnapshot.source,
          tasksCount: snapshot.taskSnapshot.tasks.length,
          todosCount: snapshot.taskSnapshot.todos?.length ?? 0,
        }
      : null,
    items: snapshot.items.map(summarizeItem),
  };
}

export function summarizeSessionUpdateForTodoToolDebug(event: SessionUpdateEvent): Record<string, unknown> {
  return {
    sessionUpdate: event.sessionUpdate,
    sessionKey: event.sessionKey,
    runId: event.runId,
    item: 'item' in event ? summarizeItem(event.item) : undefined,
    taskSnapshot: 'taskSnapshot' in event && event.taskSnapshot
      ? {
          source: event.taskSnapshot.source,
          tasksCount: event.taskSnapshot.tasks.length,
          todosCount: event.taskSnapshot.todos?.length ?? 0,
          todos: event.taskSnapshot.todos ?? [],
        }
      : undefined,
    snapshot: summarizeSnapshot(event.snapshot),
  };
}

export function logTodoToolDebug(
  logger: Pick<RuntimeHostLogger, 'traceDebug'> | undefined,
  stage: string,
  payload: unknown,
): void {
  if (!containsTodoToolDebugSignal(payload)) {
    return;
  }
  const body = payload && typeof payload === 'object'
    ? payload
    : { value: payload };
  logger?.traceDebug?.(TODO_TOOL_DEBUG_TRACE_LEVEL, `[todo-tool-debug] ${stage}`, body);
}
