import type {
  SessionRenderToolStatusKind,
} from '../../shared/session-adapter-types';
import {
  normalizeFiniteNumber,
  normalizeString,
} from './session-value-normalization';
import {
  normalizeTaskArtifactSnapshot,
  normalizeTaskToolSnapshot,
} from './task-snapshot-normalizer';
import {
  canonicalizeToolName,
  isStateOnlyToolCallSnapshotName,
  isStateOnlyToolName,
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
}): SessionRenderToolStatusKind {
  if (input.phase !== 'result') {
    return 'running';
  }
  return input.isError ? 'error' : 'completed';
}

interface NormalizedToolLifecycle {
  sessionKey: string;
  runId: string;
  sequenceId: number;
  timestamp: number;
  phase: 'start' | 'update' | 'result';
  toolCallId: string;
  toolName: string;
  isError: boolean;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
}

function normalizeToolLifecyclePayload(
  payload: GatewayConversationToolLifecyclePayload,
): NormalizedToolLifecycle | null {
  const phase = normalizeToolLifecyclePhase(payload.phase);
  const runId = normalizeString(payload.runId);
  const sessionKey = normalizeString(payload.sessionKey);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const timestamp = normalizeFiniteNumber(payload.timestamp);
  const toolCallId = normalizeString(payload.toolCallId);
  const toolName = canonicalizeToolName(payload.name);
  if (!phase || !runId || !sessionKey || sequenceId == null || timestamp == null || !toolCallId) {
    return null;
  }
  if (phase === 'start' && !toolName) {
    return null;
  }
  return {
    sessionKey,
    runId,
    sequenceId,
    timestamp,
    phase,
    toolCallId,
    toolName,
    isError: payload.isError === true,
    ...(Object.prototype.hasOwnProperty.call(payload, 'args') ? { args: payload.args } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'partialResult') ? { partialResult: payload.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'result') ? { result: payload.result } : {}),
  };
}

export function buildToolLifecycleIngressEvents(
  payload: GatewayConversationToolLifecyclePayload,
): GatewaySessionIngressEvent[] {
  const lifecycle = normalizeToolLifecyclePayload(payload);
  if (!lifecycle) {
    return [];
  }

  if (isStateOnlyToolName(lifecycle.toolName)) {
    const payloadForSnapshot = lifecycle.phase === 'start' && isStateOnlyToolCallSnapshotName(lifecycle.toolName)
      ? lifecycle.args
      : lifecycle.result;
    const taskSnapshot = normalizeTaskToolSnapshot(
      lifecycle.toolName,
      payloadForSnapshot,
      lifecycle.sessionKey,
    );
    return taskSnapshot
      ? [{
          sessionUpdate: 'plan',
          sessionKey: taskSnapshot.sessionKey,
          runId: lifecycle.runId,
          taskSnapshot,
        }]
      : [];
  }

  const events: GatewaySessionIngressEvent[] = [{
    sessionUpdate: 'tool_status_update',
    sessionKey: lifecycle.sessionKey,
    runId: lifecycle.runId,
    sequenceId: lifecycle.sequenceId,
    timestamp: lifecycle.timestamp,
    toolCallId: lifecycle.toolCallId,
    toolName: lifecycle.toolName,
    phase: lifecycle.phase,
    status: resolveToolLifecycleStatus({ phase: lifecycle.phase, isError: lifecycle.isError }),
    isError: lifecycle.isError,
    ...(lifecycle.args !== undefined ? { input: lifecycle.args } : {}),
    ...(lifecycle.partialResult !== undefined ? { partialResult: lifecycle.partialResult } : {}),
    ...(lifecycle.result !== undefined ? { output: lifecycle.result } : {}),
  }];

  const resultSnapshot = lifecycle.phase === 'result'
    ? normalizeTaskToolSnapshot(lifecycle.toolName, lifecycle.result, lifecycle.sessionKey)
    : null;
  if (resultSnapshot) {
    events.push({
      sessionUpdate: 'plan',
      sessionKey: resultSnapshot.sessionKey,
      runId: lifecycle.runId,
      taskSnapshot: resultSnapshot,
    });
  }
  const artifactSnapshot = (lifecycle.phase === 'result' && !resultSnapshot)
    ? normalizeTaskArtifactSnapshot(lifecycle.result, lifecycle.sessionKey)
    : null;
  if (artifactSnapshot) {
    events.push({
      sessionUpdate: 'plan',
      sessionKey: artifactSnapshot.sessionKey,
      runId: lifecycle.runId,
      taskSnapshot: artifactSnapshot,
    });
  }
  return events;
}
