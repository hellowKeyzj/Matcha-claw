import type { SessionTimelineEntry } from '../../shared/session-adapter-types';
import {
  buildTimelineEntriesFromTranscriptMessage,
} from './transcript-timeline-materializer';
import type { SessionTranscriptMessage } from './transcript-types';
import {
  normalizeFiniteNumber,
  normalizeString,
} from './session-value-normalization';
import {
  normalizeTimelineEntryStatus,
} from './gateway-ingress-message';
import {
  normalizeTaskArtifactSnapshot,
  normalizeTaskToolSnapshot,
} from './task-snapshot-normalizer';
import {
  isStateOnlyToolCallSnapshotName,
  isStateOnlyToolName,
  canonicalizeToolName,
} from './state-only-tools';
import type {
  GatewayConversationToolLifecyclePayload,
  GatewaySessionIngressEvent,
} from './gateway-ingress-types';

function normalizeToolLifecyclePhase(value: unknown): 'start' | 'update' | 'result' | null {
  const normalized = normalizeString(value);
  if (normalized === 'start' || normalized === 'update' || normalized === 'result') {
    return normalized;
  }
  return null;
}

function resolveToolLifecycleStatus(input: {
  phase: 'start' | 'update' | 'result';
  isError: boolean;
}): 'running' | 'completed' | 'error' {
  if (input.phase !== 'result') {
    return 'running';
  }
  return input.isError ? 'error' : 'completed';
}

function resolveExistingToolName(
  entries: ReadonlyArray<SessionTimelineEntry> | undefined,
  toolCallId: string,
): string {
  if (!entries || !toolCallId) {
    return '';
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || (entry.kind !== 'message' && entry.kind !== 'tool-activity')) {
      continue;
    }
    const toolName = entry.toolCards.find((tool) => (
      tool.toolCallId === toolCallId || tool.id === toolCallId
    ))?.name;
    if (toolName) {
      return toolName;
    }
    const toolUseName = entry.toolUses.find((toolUse) => (
      toolUse.toolCallId === toolCallId || toolUse.id === toolCallId
    ))?.name;
    if (toolUseName) {
      return toolUseName;
    }
    const toolStatusName = entry.toolStatuses.find((toolStatus) => (
      toolStatus.toolCallId === toolCallId || toolStatus.id === toolCallId
    ))?.name;
    if (toolStatusName) {
      return toolStatusName;
    }
  }
  return '';
}

function buildToolLifecycleMessage(input: {
  runId: string;
  sequenceId: number;
  timestamp: number;
  phase: 'start' | 'update' | 'result';
  toolCallId: string;
  name?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError: boolean;
}): SessionTranscriptMessage {
  const toolStatus = {
    id: input.toolCallId,
    toolCallId: input.toolCallId,
    ...(input.name ? { name: input.name } : {}),
    status: resolveToolLifecycleStatus({
      phase: input.phase,
      isError: input.isError,
    }),
    phase: input.phase,
    ...(Object.prototype.hasOwnProperty.call(input, 'partialResult') ? { partialResult: input.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'result') ? { result: input.result } : {}),
    isError: input.isError,
    updatedAt: input.timestamp,
  };

  return {
    role: 'assistant',
    id: `run:${input.runId}:tool:${input.toolCallId}`,
    content: input.phase === 'start'
      ? [{
          type: 'toolCall',
          id: input.toolCallId,
          name: input.name,
          input: input.args,
        }]
      : '',
    timestamp: input.timestamp,
    toolCallId: input.toolCallId,
    ...(input.name ? { toolName: input.name } : {}),
    toolStatuses: [toolStatus],
    isError: input.isError,
  };
}

function normalizeToolLifecyclePayload(
  payload: GatewayConversationToolLifecyclePayload,
  options: {
    existingEntries?: ReadonlyArray<SessionTimelineEntry>;
  } = {},
): { sessionKey: string; runId: string; sequenceId: number; phase: 'start' | 'update' | 'result'; message: SessionTranscriptMessage } | null {
  const phase = normalizeToolLifecyclePhase(payload.phase);
  const runId = normalizeString(payload.runId);
  const sessionKey = normalizeString(payload.sessionKey);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const timestamp = normalizeFiniteNumber(payload.timestamp);
  const toolCallId = normalizeString(payload.toolCallId);
  const name = canonicalizeToolName(payload.name)
    || resolveExistingToolName(options.existingEntries, toolCallId);
  if (!phase || !runId || !sessionKey || sequenceId == null || timestamp == null || !toolCallId) {
    return null;
  }
  if (!name) {
    return null;
  }

  const message = buildToolLifecycleMessage({
    runId,
    sequenceId,
    timestamp,
    phase,
    toolCallId,
    ...(name ? { name } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'args') ? { args: payload.args } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'partialResult') ? { partialResult: payload.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'result') ? { result: payload.result } : {}),
    isError: payload.isError === true,
  });

  return {
    sessionKey,
    runId,
    sequenceId,
    phase,
    message,
  };
}

export function buildToolLifecycleIngressEvents(
  payload: GatewayConversationToolLifecyclePayload,
  options: {
    existingEntries?: SessionTimelineEntry[];
  } = {},
): GatewaySessionIngressEvent[] {
  const toolLifecycle = normalizeToolLifecyclePayload(payload, {
    existingEntries: options.existingEntries,
  });
  if (!toolLifecycle) {
    return [];
  }
  if (isStateOnlyToolName(toolLifecycle.message.toolName)) {
    const payloadForSnapshot = toolLifecycle.phase === 'start' && isStateOnlyToolCallSnapshotName(toolLifecycle.message.toolName)
      ? payload.args
      : payload.result;
    const taskSnapshot = normalizeTaskToolSnapshot(
      toolLifecycle.message.toolName,
      payloadForSnapshot,
      toolLifecycle.sessionKey,
    );
    return taskSnapshot
      ? [{
          sessionUpdate: 'plan',
          sessionKey: taskSnapshot.sessionKey,
          runId: toolLifecycle.runId,
          taskSnapshot,
        }]
      : [];
  }
  const entries = buildTimelineEntriesFromTranscriptMessage(
    toolLifecycle.sessionKey,
    toolLifecycle.message,
    {
      runId: toolLifecycle.runId,
      sequenceId: toolLifecycle.sequenceId,
      status: toolLifecycle.phase === 'result'
        ? normalizeTimelineEntryStatus(toolLifecycle.message.isError ? 'error' : 'final')
        : 'streaming',
      index: 0,
      existingRows: options.existingEntries,
    },
  );
  if (entries.length === 0) {
    return [];
  }
  const events: GatewaySessionIngressEvent[] = [{
    sessionUpdate: 'agent_message_chunk',
    sessionKey: toolLifecycle.sessionKey,
    runId: toolLifecycle.runId,
    laneKey: entries[0]?.laneKey ?? 'main',
    entries,
  }];
  const resultSnapshot = normalizeTaskToolSnapshot(toolLifecycle.message.toolName, payload.result, toolLifecycle.sessionKey);
  if (resultSnapshot) {
    events.push({
      sessionUpdate: 'plan',
      sessionKey: resultSnapshot.sessionKey,
      runId: toolLifecycle.runId,
      taskSnapshot: resultSnapshot,
    });
  }
  const artifactSnapshot = resultSnapshot ? null : normalizeTaskArtifactSnapshot(payload.result, toolLifecycle.sessionKey);
  if (artifactSnapshot) {
    events.push({
      sessionUpdate: 'plan',
      sessionKey: artifactSnapshot.sessionKey,
      runId: toolLifecycle.runId,
      taskSnapshot: artifactSnapshot,
    });
  }
  return events;
}
