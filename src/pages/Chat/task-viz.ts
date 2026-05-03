import { readTimelineEntryToolStatuses } from '@/stores/chat/event-helpers';
import type { ToolStatus } from '@/stores/chat';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import { extractEntryText, extractEntryThinking, extractEntryToolUse } from './message-utils';

export type TaskStepStatus = 'running' | 'completed' | 'error';
export type TaskStepKind = 'thinking' | 'tool' | 'system';

export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: TaskStepKind;
  detail?: string;
  depth: number;
  parentId?: string;
}

export interface DeriveTaskStepsInput {
  entries: SessionTimelineEntry[];
  streamingEntry: SessionTimelineEntry | null;
  streamingTools: ToolStatus[];
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
}

export interface SubagentCompletionInfo {
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
}

const MAX_TASK_STEPS = 32;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function makeToolId(prefix: string, toolName: string, index: number): string {
  return `${prefix}:${toolName}:${index}`;
}

function parseLinePairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    result[key] = value;
  }
  return result;
}

function parseSpawnAgentName(step: TaskStep): string | null {
  const raw = step.detail || '';
  const match = raw.match(/"agentId"\s*:\s*"([^"]+)"/i) ?? raw.match(/agentId\s*:\s*([^\s,]+)/i);
  return match?.[1]?.trim() || null;
}

function isSpawnLikeStep(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'sessions_spawn' || /\bsessions[_-]?spawn\b/.test(normalized);
}

function attachTopology(steps: TaskStep[]): TaskStep[] {
  const withTopology: TaskStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (isSpawnLikeStep(step.label)) {
      withTopology.push({
        ...step,
        depth: 1,
        parentId: 'agent-run',
      });
      const branchAgent = parseSpawnAgentName(step) ?? 'subagent';
      const branchNodeId = `${step.id}:branch`;
      withTopology.push({
        id: branchNodeId,
        label: `${branchAgent} subagent`,
        status: step.status,
        kind: 'system',
        detail: `Spawned branch for ${branchAgent}`,
        depth: 2,
        parentId: step.id,
      });
      activeBranchNodeId = branchNodeId;
      continue;
    }

    if (/sessions_yield/i.test(step.label)) {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      activeBranchNodeId = null;
      continue;
    }

    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology.slice(0, MAX_TASK_STEPS);
}

export function parseSubagentCompletionInfo(entry: SessionTimelineEntry): SubagentCompletionInfo | null {
  if (!entry || entry.role !== 'user') {
    return null;
  }

  const text = extractEntryText(entry);
  if (!text) {
    return null;
  }

  const hasInternalHeader = /\[internal task completion event\]/i.test(text);
  const hasSubagentSource = /source\s*:\s*subagent/i.test(text);
  if (!hasInternalHeader && !hasSubagentSource) {
    return null;
  }

  const kv = parseLinePairs(text);
  const sessionKey = kv.session_key ?? kv.sessionkey ?? kv.session;
  if (!sessionKey) {
    return null;
  }
  const sessionId = kv.session_id ?? kv.sessionid;
  const agentMatch = sessionKey.match(/^agent:([^:]+):/i);
  const agentId = agentMatch?.[1];

  return {
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

export function deriveTaskSteps({
  entries,
  streamingEntry,
  streamingTools,
  sending,
  pendingFinal,
  showThinking,
}: DeriveTaskStepsInput): TaskStep[] {
  const steps: TaskStep[] = [];
  const seenIds = new Set<string>();
  const activeToolNames = new Set<string>();

  const pushStep = (step: TaskStep): void => {
    if (seenIds.has(step.id)) return;
    seenIds.add(step.id);
    steps.push(step);
  };

  const effectiveStreamingTools = streamingTools.length > 0
    ? streamingTools
    : readTimelineEntryToolStatuses(streamingEntry);

  if (streamingEntry && showThinking) {
    const thinking = extractEntryThinking(streamingEntry);
    if (thinking) {
      pushStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: normalizeText(thinking),
        depth: 1,
      });
    }
  }

  for (const [index, tool] of effectiveStreamingTools.entries()) {
    activeToolNames.add(tool.name);
    pushStep({
      id: tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index),
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: normalizeText(tool.summary),
      depth: 1,
    });
  }

  if (streamingEntry) {
    const toolUse = extractEntryToolUse(streamingEntry);
    for (const [index, tool] of toolUse.entries()) {
      if (activeToolNames.has(tool.name)) continue;
      pushStep({
        id: tool.id || makeToolId('stream-tool', tool.name, index),
        label: tool.name,
        status: 'running',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  if (sending && pendingFinal) {
    pushStep({
      id: 'system-finalizing',
      label: 'Finalizing answer',
      status: 'running',
      kind: 'system',
      detail: 'Waiting for the assistant to finish this run.',
      depth: 1,
    });
  } else if (sending && steps.length === 0) {
    pushStep({
      id: 'system-preparing',
      label: 'Preparing run',
      status: 'running',
      kind: 'system',
      detail: 'Waiting for the first streaming update.',
      depth: 1,
    });
  }

  if (steps.length === 0) {
    const relevantAssistantEntries = entries.filter((entry) => {
      if (!entry || entry.role !== 'assistant') return false;
      if (extractEntryToolUse(entry).length > 0) return true;
      return showThinking && !!extractEntryThinking(entry);
    });

    for (const [entryIndex, assistantEntry] of relevantAssistantEntries.entries()) {
      if (showThinking) {
        const thinking = extractEntryThinking(assistantEntry);
        if (thinking) {
          pushStep({
            id: `history-thinking-${assistantEntry.entryId || assistantEntry.message.id || entryIndex}`,
            label: 'Thinking',
            status: 'completed',
            kind: 'thinking',
            detail: normalizeText(thinking),
            depth: 1,
          });
        }
      }

      for (const [toolIndex, tool] of extractEntryToolUse(assistantEntry).entries()) {
        pushStep({
          id: tool.id || makeToolId(`history-tool-${assistantEntry.entryId || assistantEntry.message.id || entryIndex}`, tool.name, toolIndex),
          label: tool.name,
          status: 'completed',
          kind: 'tool',
          detail: normalizeText(JSON.stringify(tool.input, null, 2)),
          depth: 1,
        });
      }
    }
  }

  return attachTopology(steps);
}
