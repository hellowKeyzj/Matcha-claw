import type {
  SessionAssistantToolSegment,
  SessionAssistantTurnSegment,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntryStatus,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../shared/session-adapter-types';

export interface AssistantTurnEntryIdentity {
  sessionKey: string;
  runId?: string;
  agentId?: string;
  laneKey: string;
  turnKey: string;
  turnBindingSource: SessionTurnBindingSource;
  turnBindingConfidence: SessionTurnBindingConfidence;
  turnIdentityMode: SessionTurnIdentityMode;
  turnIdentityConfidence: SessionTurnIdentityConfidence;
  entryId: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
}

export function buildAssistantTurnEntryKey(
  sessionKey: string,
  laneKey: string,
  turnKey: string,
): string {
  return `session:${sessionKey}|assistant-turn:${laneKey}:${turnKey}`;
}

function projectFinalToolSegment(segment: SessionAssistantTurnSegment): SessionAssistantTurnSegment {
  if (segment.kind !== 'tool') {
    return segment;
  }
  const toolSegment = segment as SessionAssistantToolSegment;
  if (toolSegment.tool.status !== 'running') {
    return segment;
  }
  if (toolSegment.tool.result.kind !== 'none' || toolSegment.tool.output !== undefined) {
    return segment;
  }
  return {
    ...toolSegment,
    tool: {
      ...toolSegment.tool,
      status: 'missing_result',
    },
  };
}

export function buildAssistantTurnEntry(input: {
  identity: AssistantTurnEntryIdentity;
  status: SessionTimelineEntryStatus;
  text: string;
  createdAt?: number;
  sequenceId?: number;
  segments: ReadonlyArray<SessionAssistantTurnSegment>;
  isStreaming: boolean;
}): SessionTimelineAssistantTurnEntry {
  const id = input.identity;
  const segments = input.status === 'final' || input.status === 'error'
    ? input.segments.map(projectFinalToolSegment)
    : input.segments;
  return {
    key: buildAssistantTurnEntryKey(id.sessionKey, id.laneKey, id.turnKey),
    kind: 'assistant-turn',
    sessionKey: id.sessionKey,
    role: 'assistant',
    text: input.text,
    status: input.status,
    ...(input.createdAt != null ? { createdAt: input.createdAt } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    ...(id.runId ? { runId: id.runId } : {}),
    entryId: id.entryId,
    laneKey: id.laneKey,
    turnKey: id.turnKey,
    turnBindingSource: id.turnBindingSource,
    turnBindingConfidence: id.turnBindingConfidence,
    turnIdentityMode: id.turnIdentityMode,
    turnIdentityConfidence: id.turnIdentityConfidence,
    ...(id.agentId ? { agentId: id.agentId } : {}),
    ...(id.messageId ? { messageId: id.messageId } : {}),
    ...(id.originMessageId ? { originMessageId: id.originMessageId } : {}),
    ...(id.clientId ? { clientId: id.clientId } : {}),
    segments,
    isStreaming: input.isStreaming,
  };
}
