import type {
  RemoteFleetAuditEventName,
  RemoteFleetAuditEventRecord,
  RemoteFleetCommandRecord,
} from './remote-fleet-model';
import { redactRemoteFleetMessage } from './remote-fleet-audit';

export type RemoteFleetOpsTimelineEntryType = 'command-state' | 'audit-event';
export type RemoteFleetOpsTimelineSeverity = 'info' | 'warning' | 'error';
export type RemoteFleetOpsTimelineCommandStatus = RemoteFleetCommandRecord['state']['reason'];

export interface RemoteFleetOpsTimelineInput {
  readonly commands: readonly RemoteFleetCommandRecord[];
  readonly auditEvents: readonly RemoteFleetAuditEventRecord[];
  readonly maxEntries?: number;
}

export interface RemoteFleetOpsTimeline {
  readonly entries: readonly RemoteFleetOpsTimelineEntry[];
  readonly commandCount: number;
  readonly auditEventCount: number;
  readonly omittedEntryCount: number;
}

export interface RemoteFleetOpsTimelineTargetIds {
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
}

export interface RemoteFleetOpsTimelineCommandRef extends RemoteFleetOpsTimelineTargetIds {
  readonly id: string;
  readonly commandName: string;
  readonly status: RemoteFleetOpsTimelineCommandStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly active: boolean;
  readonly terminal: boolean;
  readonly message?: string;
}

export interface RemoteFleetOpsTimelineAuditEventRef extends RemoteFleetOpsTimelineTargetIds {
  readonly id: string;
  readonly eventName: RemoteFleetAuditEventName;
  readonly occurredAt: string;
  readonly commandId?: string;
  readonly message?: string;
}

export type RemoteFleetOpsTimelineEntry =
  | RemoteFleetOpsTimelineCommandStateEntry
  | RemoteFleetOpsTimelineAuditEventEntry;

export interface RemoteFleetOpsTimelineCommandStateEntry {
  readonly id: string;
  readonly entryType: 'command-state';
  readonly occurredAt: string;
  readonly severity: RemoteFleetOpsTimelineSeverity;
  readonly targetIds: RemoteFleetOpsTimelineTargetIds;
  readonly command: RemoteFleetOpsTimelineCommandRef;
  readonly relatedAuditEventIds: readonly string[];
}

export interface RemoteFleetOpsTimelineAuditEventEntry {
  readonly id: string;
  readonly entryType: 'audit-event';
  readonly occurredAt: string;
  readonly severity: RemoteFleetOpsTimelineSeverity;
  readonly targetIds: RemoteFleetOpsTimelineTargetIds;
  readonly auditEvent: RemoteFleetOpsTimelineAuditEventRef;
  readonly command?: RemoteFleetOpsTimelineCommandRef;
}

export function buildRemoteFleetOpsTimeline(input: RemoteFleetOpsTimelineInput): RemoteFleetOpsTimeline {
  const commandById = new Map(input.commands.map((command) => [command.id, command]));
  const auditEventsByCommandId = groupAuditEventsByCommandId(input.auditEvents);
  const entries = [
    ...input.commands.map((command) => buildCommandStateEntry(command, auditEventsByCommandId.get(command.id) ?? [])),
    ...input.auditEvents.map((event) => buildAuditEventEntry(event, commandById.get(event.commandId ?? ''))),
  ].sort(compareTimelineEntriesDescending);
  const maxEntries = input.maxEntries === undefined ? entries.length : Math.max(0, input.maxEntries);
  const limitedEntries = entries.slice(0, maxEntries);

  return {
    entries: limitedEntries,
    commandCount: input.commands.length,
    auditEventCount: input.auditEvents.length,
    omittedEntryCount: entries.length - limitedEntries.length,
  };
}

function buildCommandStateEntry(
  command: RemoteFleetCommandRecord,
  auditEvents: readonly RemoteFleetAuditEventRecord[],
): RemoteFleetOpsTimelineCommandStateEntry {
  return {
    id: `command:${command.id}:state`,
    entryType: 'command-state',
    occurredAt: readCommandStateOccurredAt(command),
    severity: readCommandSeverity(command),
    targetIds: buildTargetIds(command),
    command: buildCommandRef(command),
    relatedAuditEventIds: auditEvents
      .slice()
      .sort(compareAuditEventsAscending)
      .map((event) => event.id),
  };
}

function buildAuditEventEntry(
  event: RemoteFleetAuditEventRecord,
  command: RemoteFleetCommandRecord | undefined,
): RemoteFleetOpsTimelineAuditEventEntry {
  return {
    id: `audit:${event.id}`,
    entryType: 'audit-event',
    occurredAt: event.occurredAt,
    severity: readAuditEventSeverity(event, command),
    targetIds: buildTargetIds({
      nodeId: event.nodeId ?? command?.nodeId,
      agentId: event.agentId ?? command?.agentId,
      runtimeId: event.runtimeId ?? command?.runtimeId,
      endpointId: event.endpointId ?? command?.endpointId,
    }),
    auditEvent: buildAuditEventRef(event, command),
    ...(command ? { command: buildCommandRef(command) } : {}),
  };
}

function buildCommandRef(command: RemoteFleetCommandRecord): RemoteFleetOpsTimelineCommandRef {
  const active = isActiveCommand(command);
  return {
    id: command.id,
    commandName: command.command,
    status: command.state.reason,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    active,
    terminal: !active,
    ...buildTargetIds(command),
    ...readOptionalRedactedMessage(readCommandMessage(command)),
  };
}

function buildAuditEventRef(
  event: RemoteFleetAuditEventRecord,
  command: RemoteFleetCommandRecord | undefined,
): RemoteFleetOpsTimelineAuditEventRef {
  return {
    id: event.id,
    eventName: event.eventName,
    occurredAt: event.occurredAt,
    ...(event.commandId ?? command?.id ? { commandId: event.commandId ?? command?.id } : {}),
    ...buildTargetIds({
      nodeId: event.nodeId ?? command?.nodeId,
      agentId: event.agentId ?? command?.agentId,
      runtimeId: event.runtimeId ?? command?.runtimeId,
      endpointId: event.endpointId ?? command?.endpointId,
    }),
    ...readOptionalRedactedMessage(event.message),
  };
}

function groupAuditEventsByCommandId(
  auditEvents: readonly RemoteFleetAuditEventRecord[],
): ReadonlyMap<string, readonly RemoteFleetAuditEventRecord[]> {
  const auditEventsByCommandId = new Map<string, RemoteFleetAuditEventRecord[]>();
  for (const event of auditEvents) {
    if (!event.commandId) {
      continue;
    }
    const events = auditEventsByCommandId.get(event.commandId) ?? [];
    events.push(event);
    auditEventsByCommandId.set(event.commandId, events);
  }
  return auditEventsByCommandId;
}

function buildTargetIds(targets: RemoteFleetOpsTimelineTargetIds): RemoteFleetOpsTimelineTargetIds {
  return {
    ...(targets.nodeId ? { nodeId: targets.nodeId } : {}),
    ...(targets.agentId ? { agentId: targets.agentId } : {}),
    ...(targets.runtimeId ? { runtimeId: targets.runtimeId } : {}),
    ...(targets.endpointId ? { endpointId: targets.endpointId } : {}),
  };
}

function readCommandStateOccurredAt(command: RemoteFleetCommandRecord): string {
  switch (command.state.reason) {
    case 'queued':
      return command.state.queuedAt;
    case 'running':
      return command.state.startedAt;
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'timed-out':
      return command.state.completedAt;
  }
}

function readCommandMessage(command: RemoteFleetCommandRecord): string | undefined {
  switch (command.state.reason) {
    case 'failed':
      return command.state.message;
    case 'cancelled':
      return command.state.message ?? command.message;
    case 'timed-out':
      return command.message ?? `Remote Fleet command timed out after ${command.state.timeoutMs}ms.`;
    case 'queued':
    case 'running':
    case 'succeeded':
      return command.message;
  }
}

function readCommandSeverity(command: RemoteFleetCommandRecord): RemoteFleetOpsTimelineSeverity {
  switch (command.state.reason) {
    case 'failed':
    case 'timed-out':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'queued':
    case 'running':
    case 'succeeded':
      return 'info';
  }
}

function readAuditEventSeverity(
  event: RemoteFleetAuditEventRecord,
  command: RemoteFleetCommandRecord | undefined,
): RemoteFleetOpsTimelineSeverity {
  switch (event.eventName) {
    case 'remoteFleet.command.completed':
    case 'remoteFleet.runtime.started':
    case 'remoteFleet.runtime.stopped':
      return command ? readCommandSeverity(command) : 'info';
    case 'remoteFleet.node.removed':
    case 'remoteFleet.agent.revoked':
    case 'remoteFleet.endpoint.drained':
    case 'remoteFleet.endpoint.retired':
      return 'warning';
    default:
      return 'info';
  }
}

function isActiveCommand(command: RemoteFleetCommandRecord): boolean {
  return command.state.reason === 'queued' || command.state.reason === 'running';
}

function readOptionalRedactedMessage(message: string | undefined): { readonly message?: string } {
  if (!message) {
    return {};
  }
  const redacted = redactRemoteFleetMessage(message);
  return redacted.length > 0 ? { message: redacted } : {};
}

function compareTimelineEntriesDescending(
  left: RemoteFleetOpsTimelineEntry,
  right: RemoteFleetOpsTimelineEntry,
): number {
  const timeOrder = right.occurredAt.localeCompare(left.occurredAt);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return left.id.localeCompare(right.id);
}

function compareAuditEventsAscending(left: RemoteFleetAuditEventRecord, right: RemoteFleetAuditEventRecord): number {
  const timeOrder = left.occurredAt.localeCompare(right.occurredAt);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return left.id.localeCompare(right.id);
}
