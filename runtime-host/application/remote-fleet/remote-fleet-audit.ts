import type {
  RemoteFleetAuditEventName,
  RemoteFleetAuditEventRecord,
  RemoteFleetAuditEventSummary,
} from './remote-fleet-model';
import { redactRemoteFleetLogLine } from './remote-fleet-log-stream';

const REDACTED_VALUE = '[redacted]';
const SENSITIVE_KEY_PATTERN = /(?:token|secret|authorization|api[_-]?key|private[_-]?key|password)/i;

type RemoteFleetAuditEventRecordInput = {
  readonly id: string;
  readonly eventName: RemoteFleetAuditEventName;
  readonly occurredAt: string;
  readonly actorId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandId?: string;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
};

export function redactRemoteFleetMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactRemoteFleetRecord(metadata);
}

export function createRemoteFleetAuditEventRecord(input: RemoteFleetAuditEventRecordInput): RemoteFleetAuditEventRecord {
  return {
    id: input.id,
    eventName: input.eventName,
    occurredAt: input.occurredAt,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(input.message ? { message: redactRemoteFleetMessage(input.message) } : {}),
    ...(input.metadata ? { metadata: redactRemoteFleetMetadata(input.metadata) } : {}),
  };
}

export function redactRemoteFleetMessage(message: string): string {
  return redactRemoteFleetLogLine(message);
}

export function summarizeRemoteFleetAuditEvent(event: RemoteFleetAuditEventRecord): RemoteFleetAuditEventSummary {
  return {
    id: event.id,
    eventName: event.eventName,
    occurredAt: event.occurredAt,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}),
    ...(event.endpointId ? { endpointId: event.endpointId } : {}),
    ...(event.commandId ? { commandId: event.commandId } : {}),
    ...(event.message ? { message: event.message } : {}),
  };
}

function redactRemoteFleetValue(key: string, value: unknown): unknown {
  if (isSensitiveRemoteFleetMetadataKey(key)) {
    return REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return redactRemoteFleetLogLine(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactRemoteFleetValue('', item));
  }

  if (isPlainRemoteFleetRecord(value)) {
    return redactRemoteFleetRecord(value);
  }

  return value;
}

function redactRemoteFleetRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, redactRemoteFleetValue(key, value)]),
  );
}

function isSensitiveRemoteFleetMetadataKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isPlainRemoteFleetRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
