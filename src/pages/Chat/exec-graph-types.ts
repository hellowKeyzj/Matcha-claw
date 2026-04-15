import type { RawMessage, ToolStatus } from '@/stores/chat';
import type { ExecutionGraphData } from './chat-row-model';
import type { TaskStep } from './task-viz';

export const SUBAGENT_HISTORY_LIMIT = 200;
export const SUBAGENT_HISTORY_CACHE_MAX_SESSIONS = 48;
export const EXECUTION_GRAPH_FIRST_BATCH_SIZE = 1;
export const EXECUTION_GRAPH_BATCH_SIZE = 3;
export const EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS = 4;
export const EXECUTION_GRAPH_MAIN_STEPS_CACHE_MAX = 320;
export const EXECUTION_GRAPH_CHILD_STEPS_CACHE_MAX = 320;
export const EXECUTION_GRAPH_CACHE_MAX_SESSIONS = 20;

export const EMPTY_MESSAGES: RawMessage[] = [];
export const EMPTY_TASK_STEPS: TaskStep[] = [];
export const EMPTY_EXECUTION_GRAPHS: ExecutionGraphData[] = [];
export const EMPTY_GRAPH_SIGNATURES: string[] = [];
export const EMPTY_ANCHOR_GRAPH_MAP: Array<ExecutionGraphData | null> = [];
export const EMPTY_SUPPRESSED_KEYS = new Set<string>();

export interface CompletionEventAnchor {
  eventIndex: number;
  triggerIndex: number;
  replyIndex: number | null;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
}

export interface ExecutionGraphAgent {
  id: string;
  name?: string;
}

export interface MessageKeyIndexSnapshot {
  messagesRef: RawMessage[];
  keyByIndex: Map<number, string>;
  renderableCount: number;
}

export interface AnchorsSnapshot {
  messagesRef: RawMessage[];
  anchors: CompletionEventAnchor[];
}

export interface SessionExecutionCache {
  messagesRef: RawMessage[];
  agentsRef: ExecutionGraphAgent[];
  subagentHistoryRevision: number;
  streamingMessageRef: unknown | null;
  streamingToolsRef: ToolStatus[];
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
  executionGraphs: ExecutionGraphData[];
  suppressedToolCardRowKeys: Set<string>;
  keyIndex: MessageKeyIndexSnapshot;
  anchors: AnchorsSnapshot;
  graphSignaturesByAnchor: string[];
  graphByAnchor: Array<ExecutionGraphData | null>;
  graphCacheBySignature: Map<string, ExecutionGraphData>;
  mainStepsCacheBySignature: Map<string, TaskStep[]>;
  childStepsCacheBySignature: Map<string, TaskStep[]>;
}

export type IdleCallbackHandle = number | ReturnType<typeof setTimeout>;
