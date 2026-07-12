import { buildSessionIdentityScopedMessageId } from '../../../agent-runtime/contracts/runtime-identity-contract';
import {
  iterateCanonicalReplayEventsFromTranscriptMessages,
  iterateCanonicalReplayEventsFromTranscriptMessagesAsync,
} from '../../../sessions/canonical/canonical-transcript-replay';
import { iterateTranscriptMessages, iterateTranscriptMessagesAsync } from '../../../sessions/transcript-parser';
import type {
  RuntimeEventAdapter,
  RuntimeProtocolAdapter,
  RuntimeReplayAdapter,
  RuntimeSessionContext,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  CanonicalApprovalEvent,
  CanonicalEventBase,
  CanonicalMessagePartEvent,
  CanonicalSessionEvent,
  CanonicalThoughtEvent,
  CanonicalToolEvent,
  CanonicalUsageEvent,
} from '../../../sessions/canonical/canonical-events';
import type { SessionApprovalDecision } from '../../../../shared/session-adapter-types';
import {
  MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
} from './matcha-agent-runtime-identity';

type MatchaAgentEventSource = 'live' | 'replay';

type SdkTextDeltaAccumulator = Map<string, SdkTextDeltaAccumulatorEntry>;

type SdkTextDeltaAccumulatorEntry = {
  sessionId: string;
  runId: string | undefined;
  messageId: string;
  blockIndex: string;
  text: string;
};

type OwnerBinding = Pick<
  CanonicalEventBase,
  | 'ownerTurnKey'
  | 'ownerMessageKey'
  | 'turnBindingSource'
  | 'turnBindingConfidence'
  | 'messageBindingSource'
  | 'messageBindingConfidence'
>;

type CanonicalEventBaseFields = Omit<CanonicalEventBase, 'type'>;

type ToolCallMetadata = Map<string, ToolCallMetadataEntry>;

type ToolCallMetadataEntry = {
  sessionId: string;
  runId: string | undefined;
  toolCallId: string;
  messageId?: string;
  name?: string;
  input?: unknown;
  ownerBinding?: OwnerBinding;
};

type SdkToolBlockIndex = Map<string, SdkToolBlockIndexEntry>;

type SdkToolBlockIndexEntry = {
  sessionId: string;
  runId: string | undefined;
  messageId: string;
  blockIndex: string;
  toolCallId: string;
};

type MatchaAgentTranslationState = {
  sdkTextDeltaAccumulator: SdkTextDeltaAccumulator;
  toolCallMetadata: ToolCallMetadata;
  sdkToolBlockIndex: SdkToolBlockIndex;
};

type AppServerEventEnvelope = {
  eventId: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  runId?: string;
  workerId?: string;
  event: Record<string, unknown> & { type: string };
};

class MatchaAgentRuntimeEventAdapter implements RuntimeEventAdapter {
  private readonly state = createTranslationState();

  canTranslate(input: unknown, context: RuntimeSessionContext): boolean {
    return context.protocolId === MATCHA_AGENT_RUNTIME_PROTOCOL_ID && isAppServerEventEnvelope(input);
  }

  translate(input: unknown, context: RuntimeSessionContext): CanonicalSessionEvent[] {
    if (!isAppServerEventEnvelope(input)) return [];
    return translateAppServerEventEnvelope(input, context, 'live', this.state);
  }
}

class MatchaAgentRuntimeReplayAdapter implements RuntimeReplayAdapter {
  replayTranscript(
    sessionKey: string,
    transcript: Parameters<RuntimeReplayAdapter['replayTranscript']>[1],
    context: RuntimeSessionContext,
  ): ReturnType<RuntimeReplayAdapter['replayTranscript']> {
    const identity = {
      protocolId: MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
    };
    if (typeof transcript === 'string' || Symbol.iterator in Object(transcript)) {
      return iterateCanonicalReplayEventsFromTranscriptMessages(
        sessionKey,
        iterateTranscriptMessages(transcript as string | Iterable<string>),
        identity,
      );
    }
    return iterateCanonicalReplayEventsFromTranscriptMessagesAsync(
      sessionKey,
      iterateTranscriptMessagesAsync(transcript),
      identity,
    );
  }
}

export class MatchaAgentProtocolAdapter implements RuntimeProtocolAdapter {
  readonly protocolId = MATCHA_AGENT_RUNTIME_PROTOCOL_ID;
  readonly eventAdapter: RuntimeEventAdapter = new MatchaAgentRuntimeEventAdapter();
  readonly replayAdapter: RuntimeReplayAdapter = new MatchaAgentRuntimeReplayAdapter();
  readonly identityPolicy = {
    buildMessageId: (input: Parameters<RuntimeProtocolAdapter['identityPolicy']['buildMessageId']>[0]) => buildSessionIdentityScopedMessageId(input),
  };
}

function createTranslationState(): MatchaAgentTranslationState {
  return {
    sdkTextDeltaAccumulator: new Map(),
    toolCallMetadata: new Map(),
    sdkToolBlockIndex: new Map(),
  };
}

function translateAppServerEventEnvelope(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
): CanonicalSessionEvent[] {
  const event = envelope.event;
  switch (event.type) {
    case 'run.started':
      return [createLifecycleEvent(envelope, context, source, 'started', 'submitted', null)];
    case 'run.completed': {
      const events: CanonicalSessionEvent[] = [createLifecycleEvent(envelope, context, source, 'final', 'done', null)];
      if (event.usage !== undefined) events.push(createUsageEvent(envelope, context, source, event.usage));
      clearStateForRun(state, envelope);
      return events;
    }
    case 'run.failed':
      clearStateForRun(state, envelope);
      return [createLifecycleEvent(envelope, context, source, 'error', 'error', readErrorMessage(event.error))];
    case 'run.cancelled':
    case 'run.interrupted':
      clearStateForRun(state, envelope);
      return [createLifecycleEvent(envelope, context, source, 'aborted', 'aborted', readString(event.reason))];
    case 'message.delta':
      return translateMessageDelta(envelope, context, source, state);
    case 'message.completed':
      return [];
    case 'sdk.message':
      return translateSdkMessage(envelope, context, source, state);
    case 'tool.started':
      return translateNativeToolEvent(envelope, context, source, state, 'started');
    case 'tool.progress':
      return translateNativeToolEvent(envelope, context, source, state, 'updated');
    case 'tool.completed':
      return translateNativeToolEvent(envelope, context, source, state, 'completed');
    case 'tool.failed':
      return translateNativeToolEvent(envelope, context, source, state, 'failed');
    case 'approval.requested':
    case 'approval.resolved':
      return translateApprovalEvent(envelope, context, source);
    case 'usage.updated':
      return [createUsageEvent(envelope, context, source, event.usage)];
    default:
      return [];
  }
}

function translateMessageDelta(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
): CanonicalSessionEvent[] {
  const event = envelope.event;
  const messageId = readString(event.messageId);
  const delta = readTextContent(event.delta);
  if (!messageId || delta === null || delta === '') return [];

  const channel = readString(event.channel);
  if (channel === 'thinking') {
    const thoughtEvent: CanonicalThoughtEvent = {
      ...canonicalBase(envelope, context, source, `thought:${messageId}:delta`),
      ...ownerBindingForMessage(envelope, context, messageId),
      type: 'thought',
      thoughtId: `${messageId}:thinking`,
      mode: 'delta',
      text: delta,
      status: 'streaming',
    };
    return [thoughtEvent];
  }

  if (channel === 'tool') {
    const toolCallId = readString(event.toolCallId);
    if (!toolCallId) return [];
    return [createToolEvent({
      envelope,
      context,
      source,
      state,
      phase: 'updated',
      toolCallId,
      messageId,
      partialResult: delta,
      outputText: delta,
      part: `message:${messageId}:tool:${toolCallId}:delta`,
    })];
  }

  const messageEvent: CanonicalMessagePartEvent = {
    ...canonicalBase(envelope, context, source, `message:${messageId}:delta`),
    ...ownerBindingForMessage(envelope, context, messageId),
    type: 'message_part',
    partId: `${messageId}:text`,
    role: 'assistant',
    kind: 'text',
    mode: 'delta',
    messageId,
    originMessageId: messageId,
    content: delta,
    text: delta,
    status: 'streaming',
  };
  return [messageEvent];
}

function translateSdkMessage(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
): CanonicalSessionEvent[] {
  const sdkMessage = asRecord(envelope.event.sdkMessage);
  if (!sdkMessage) return [];

  const projectionHints = asRecord(envelope.event.projectionHints);
  const messageId = readSdkMessageId(envelope, sdkMessage, projectionHints);
  const streamEvent = asRecord(sdkMessage.event);
  if (streamEvent) {
    const streamEvents = translateSdkStreamEvent(envelope, context, source, state, sdkMessage, streamEvent, projectionHints, messageId);
    if (streamEvents.length > 0) return streamEvents;
  }

  if (sdkMessage.type === 'assistant') {
    return translateSdkAssistantMessage(envelope, context, source, state, sdkMessage, projectionHints, messageId);
  }

  if (sdkMessage.type === 'tool_progress') {
    return translateSdkToolProgressMessage(envelope, context, source, state, sdkMessage, projectionHints, messageId);
  }

  return translateSdkToolResultMessage(envelope, context, source, state, sdkMessage, projectionHints, messageId);
}

function translateSdkStreamEvent(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
  sdkMessage: Record<string, unknown>,
  streamEvent: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
  messageId: string,
): CanonicalSessionEvent[] {
  const contentBlock = asRecord(streamEvent.content_block);
  if (streamEvent.type === 'content_block_start' && contentBlock?.type === 'tool_use') {
    const toolCallId = readToolUseBlockToolCallId(contentBlock, projectionHints);
    if (!toolCallId) return [];
    const blockIndex = readBlockIndex(streamEvent.index);
    rememberSdkToolBlock(state.sdkToolBlockIndex, envelope, messageId, blockIndex, toolCallId);
    return [createToolEvent({
      envelope,
      context,
      source,
      state,
      phase: 'started',
      toolCallId,
      messageId,
      name: readToolName(contentBlock),
      toolInput: contentBlock.input,
      part: `sdk:${messageId}:tool:${toolCallId}:start`,
    })];
  }

  const delta = asRecord(streamEvent.delta);
  if (streamEvent.type === 'content_block_delta' && delta?.type === 'text_delta') {
    const text = readTextContent(delta.text);
    if (text === null) return [];
    const accumulatedText = appendSdkTextDelta(state.sdkTextDeltaAccumulator, envelope, messageId, streamEvent, text);
    return createAssistantMessagePartEvents({
      envelope,
      context,
      source,
      messageId,
      mode: 'snapshot',
      content: accumulatedText,
      text: accumulatedText,
      status: 'streaming',
      part: `sdk:${messageId}:delta`,
    });
  }

  if (streamEvent.type === 'content_block_delta' && (delta?.type === 'input_json_delta' || delta?.type === 'partial_json')) {
    const inputDelta = readTextContent(delta.partial_json) ?? readTextContent(delta.partialJson) ?? readTextContent(delta.text);
    if (inputDelta === null || inputDelta === '') return [];
    const toolCallId = readSdkInputDeltaToolCallId(envelope, state, messageId, streamEvent, delta, projectionHints);
    if (!toolCallId) return [];
    return [createToolEvent({
      envelope,
      context,
      source,
      state,
      phase: 'updated',
      toolCallId,
      messageId,
      inputDelta,
      part: `sdk:${messageId}:tool:${toolCallId}:input-delta`,
    })];
  }

  if (streamEvent.type === 'tool_progress') {
    return translateSdkToolProgressMessage(envelope, context, source, state, sdkMessage, projectionHints, messageId);
  }

  return [];
}

function translateSdkAssistantMessage(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
  sdkMessage: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
  messageId: string,
): CanonicalSessionEvent[] {
  const content = readSdkMessageContent(sdkMessage);
  clearSdkTextDeltas(state.sdkTextDeltaAccumulator, envelope, messageId);

  const events: CanonicalSessionEvent[] = [];
  const textBlockTexts = content.flatMap(readTextBlockText);
  const text = textBlockTexts.join('');
  events.push(...createAssistantMessagePartEvents({
    envelope,
    context,
    source,
    messageId,
    mode: 'final',
    content,
    text,
    status: 'final',
    part: `sdk:${messageId}:final`,
  }));

  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== 'tool_use') continue;
    const toolCallId = readToolUseBlockToolCallId(record, projectionHints);
    if (!toolCallId) continue;
    events.push(createToolEvent({
      envelope,
      context,
      source,
      state,
      phase: 'started',
      toolCallId,
      messageId,
      name: readToolName(record),
      toolInput: record.input,
      part: `sdk:${messageId}:tool:${toolCallId}:final-start`,
    }));
  }

  return events;
}

function translateSdkToolResultMessage(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
  sdkMessage: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
  messageId: string,
): CanonicalSessionEvent[] {
  const content = readSdkMessageContent(sdkMessage);
  const events: CanonicalSessionEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== 'tool_result' && record?.type !== 'tool_use_result') continue;
    const toolCallId = readToolResultBlockToolCallId(record, projectionHints);
    if (!toolCallId) continue;
    const output = readToolResultOutput(record);
    const outputText = readToolOutputText(output) ?? readErrorMessage(output) ?? undefined;
    events.push(createToolEvent({
      envelope,
      context,
      source,
      state,
      phase: isToolResultError(record) ? 'failed' : 'completed',
      toolCallId,
      output,
      outputText,
      part: `sdk:${messageId}:tool:${toolCallId}:result`,
    }));
  }
  return events;
}

function translateSdkToolProgressMessage(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
  sdkMessage: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
  messageId: string,
): CanonicalSessionEvent[] {
  const toolCallId = readToolProgressToolCallId(sdkMessage, projectionHints);
  if (!toolCallId) return [];
  const content = readFirstDefined(sdkMessage.content, sdkMessage.delta, sdkMessage.progress, asRecord(sdkMessage.message)?.content);
  return [createToolEvent({
    envelope,
    context,
    source,
    state,
    phase: 'updated',
    toolCallId,
    messageId,
    name: readToolName(sdkMessage),
    partialResult: content,
    outputText: readToolOutputText(content),
    part: `sdk:${messageId}:tool:${toolCallId}:progress`,
  })];
}

function appendSdkTextDelta(
  accumulator: SdkTextDeltaAccumulator,
  envelope: AppServerEventEnvelope,
  messageId: string,
  streamEvent: Record<string, unknown>,
  textDelta: string,
): string {
  const blockIndex = readBlockIndex(streamEvent.index);
  const key = sdkTextDeltaAccumulatorKey(envelope.sessionId, envelope.runId, messageId, blockIndex);
  const previousText = accumulator.get(key)?.text ?? '';
  const text = previousText + textDelta;
  accumulator.set(key, {
    sessionId: envelope.sessionId,
    runId: envelope.runId,
    messageId,
    blockIndex,
    text,
  });
  return readAccumulatedSdkMessageText(accumulator, envelope, messageId);
}

function readAccumulatedSdkMessageText(
  accumulator: SdkTextDeltaAccumulator,
  envelope: AppServerEventEnvelope,
  messageId: string,
): string {
  return Array.from(accumulator.values())
    .filter((entry) => entry.sessionId === envelope.sessionId && entry.runId === envelope.runId && entry.messageId === messageId)
    .sort((left, right) => Number(left.blockIndex) - Number(right.blockIndex))
    .map((entry) => entry.text)
    .join('');
}

function clearSdkTextDeltas(
  accumulator: SdkTextDeltaAccumulator,
  envelope: AppServerEventEnvelope,
  messageId: string,
): void {
  for (const [key, entry] of accumulator) {
    if (entry.sessionId === envelope.sessionId && entry.runId === envelope.runId && entry.messageId === messageId) {
      accumulator.delete(key);
    }
  }
}

function clearStateForRun(state: MatchaAgentTranslationState, envelope: AppServerEventEnvelope): void {
  clearSdkTextDeltasForRun(state.sdkTextDeltaAccumulator, envelope);
  clearToolMetadataForRun(state.toolCallMetadata, envelope);
  clearSdkToolBlockIndexForRun(state.sdkToolBlockIndex, envelope);
}

function clearSdkTextDeltasForRun(accumulator: SdkTextDeltaAccumulator, envelope: AppServerEventEnvelope): void {
  for (const [key, entry] of accumulator) {
    if (entry.sessionId === envelope.sessionId && entry.runId === envelope.runId) {
      accumulator.delete(key);
    }
  }
}

function clearToolMetadataForRun(toolCallMetadata: ToolCallMetadata, envelope: AppServerEventEnvelope): void {
  for (const [key, entry] of toolCallMetadata) {
    if (entry.sessionId === envelope.sessionId && entry.runId === envelope.runId) {
      toolCallMetadata.delete(key);
    }
  }
}

function clearSdkToolBlockIndexForRun(sdkToolBlockIndex: SdkToolBlockIndex, envelope: AppServerEventEnvelope): void {
  for (const [key, entry] of sdkToolBlockIndex) {
    if (entry.sessionId === envelope.sessionId && entry.runId === envelope.runId) {
      sdkToolBlockIndex.delete(key);
    }
  }
}

function sdkTextDeltaAccumulatorKey(sessionId: string, runId: string | undefined, messageId: string, blockIndex: string): string {
  return JSON.stringify([sessionId, runId ?? null, messageId, blockIndex]);
}

function toolCallMetadataKey(sessionId: string, runId: string | undefined, toolCallId: string): string {
  return JSON.stringify([sessionId, runId ?? null, toolCallId]);
}

function sdkToolBlockIndexKey(sessionId: string, runId: string | undefined, messageId: string, blockIndex: string): string {
  return JSON.stringify([sessionId, runId ?? null, messageId, blockIndex]);
}

function readBlockIndex(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

function createAssistantMessagePartEvents(input: {
  envelope: AppServerEventEnvelope;
  context: RuntimeSessionContext;
  source: MatchaAgentEventSource;
  messageId: string;
  mode: CanonicalMessagePartEvent['mode'];
  content: unknown;
  text: string;
  status: CanonicalMessagePartEvent['status'];
  part: string;
}): CanonicalSessionEvent[] {
  if (input.text === '') return [];
  const messageEvent: CanonicalMessagePartEvent = {
    ...canonicalBase(input.envelope, input.context, input.source, input.part),
    ...ownerBindingForMessage(input.envelope, input.context, input.messageId),
    type: 'message_part',
    partId: `${input.messageId}:text`,
    role: 'assistant',
    kind: 'text',
    mode: input.mode,
    messageId: input.messageId,
    originMessageId: input.messageId,
    content: input.content,
    text: input.text,
    status: input.status,
  };
  return [messageEvent];
}

function createToolEvent(input: {
  envelope: AppServerEventEnvelope;
  context: RuntimeSessionContext;
  source: MatchaAgentEventSource;
  state: MatchaAgentTranslationState;
  phase: CanonicalToolEvent['phase'];
  toolCallId: string;
  messageId?: string;
  name?: string;
  toolInput?: unknown;
  inputDelta?: string;
  partialResult?: unknown;
  output?: unknown;
  outputText?: string;
  part: string;
}): CanonicalToolEvent {
  const existing = readToolMetadata(input.state.toolCallMetadata, input.envelope, input.toolCallId);
  const ownerBinding = existing?.ownerBinding ?? ownerBindingForTool(input.envelope, input.context, input.messageId);
  const name = input.name || existing?.name;
  const toolInput = readMergedToolInput(input.toolInput !== undefined ? input.toolInput : existing?.input, input.inputDelta);
  rememberToolMetadata(input.state.toolCallMetadata, input.envelope, input.toolCallId, {
    messageId: input.messageId ?? existing?.messageId,
    name,
    input: toolInput,
    ownerBinding,
  });

  return {
    ...canonicalBase(input.envelope, input.context, input.source, input.part, input.toolCallId),
    ...ownerBinding,
    type: 'tool',
    toolCallId: input.toolCallId,
    phase: input.phase,
    ...(name ? { name } : {}),
    ...(toolInput !== undefined ? { input: toolInput } : {}),
    ...(input.inputDelta !== undefined ? { inputDelta: input.inputDelta } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.outputText !== undefined ? { outputText: input.outputText } : {}),
  };
}

function rememberToolMetadata(
  toolCallMetadata: ToolCallMetadata,
  envelope: AppServerEventEnvelope,
  toolCallId: string,
  update: {
    messageId?: string;
    name?: string;
    input?: unknown;
    ownerBinding?: OwnerBinding;
  },
): void {
  const key = toolCallMetadataKey(envelope.sessionId, envelope.runId, toolCallId);
  const existing = toolCallMetadata.get(key);
  const input = update.input !== undefined ? update.input : existing?.input;
  toolCallMetadata.set(key, {
    sessionId: envelope.sessionId,
    runId: envelope.runId,
    toolCallId,
    ...(update.messageId || existing?.messageId ? { messageId: update.messageId || existing?.messageId } : {}),
    ...(update.name || existing?.name ? { name: update.name || existing?.name } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(update.ownerBinding || existing?.ownerBinding ? { ownerBinding: update.ownerBinding ?? existing?.ownerBinding } : {}),
  });
}

function readToolMetadata(
  toolCallMetadata: ToolCallMetadata,
  envelope: AppServerEventEnvelope,
  toolCallId: string,
): ToolCallMetadataEntry | undefined {
  return toolCallMetadata.get(toolCallMetadataKey(envelope.sessionId, envelope.runId, toolCallId));
}

function rememberSdkToolBlock(
  sdkToolBlockIndex: SdkToolBlockIndex,
  envelope: AppServerEventEnvelope,
  messageId: string,
  blockIndex: string,
  toolCallId: string,
): void {
  sdkToolBlockIndex.set(sdkToolBlockIndexKey(envelope.sessionId, envelope.runId, messageId, blockIndex), {
    sessionId: envelope.sessionId,
    runId: envelope.runId,
    messageId,
    blockIndex,
    toolCallId,
  });
}

function readSdkInputDeltaToolCallId(
  envelope: AppServerEventEnvelope,
  state: MatchaAgentTranslationState,
  messageId: string,
  streamEvent: Record<string, unknown>,
  delta: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
): string {
  const hintedToolCallId = readString(projectionHints?.toolCallId);
  if (hintedToolCallId) return hintedToolCallId;
  const deltaToolCallId = readString(delta.toolCallId) || readString(delta.tool_use_id) || readString(delta.toolUseId);
  if (deltaToolCallId) return deltaToolCallId;
  const streamToolCallId = readString(streamEvent.toolCallId) || readString(streamEvent.tool_use_id) || readString(streamEvent.toolUseId);
  if (streamToolCallId) return streamToolCallId;
  const blockIndex = readBlockIndex(streamEvent.index);
  return state.sdkToolBlockIndex.get(sdkToolBlockIndexKey(envelope.sessionId, envelope.runId, messageId, blockIndex))?.toolCallId ?? '';
}

function translateNativeToolEvent(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  state: MatchaAgentTranslationState,
  phase: CanonicalToolEvent['phase'],
): CanonicalSessionEvent[] {
  const event = envelope.event;
  const toolCallId = readString(event.toolCallId);
  if (!toolCallId) return [];
  const projectionHints = asRecord(event.projectionHints);
  const messageId = readString(event.messageId) || readString(projectionHints?.messageId) || undefined;
  const output = phase === 'failed' && event.error !== undefined ? event.error : event.result;
  const outputText = phase === 'failed'
    ? readErrorMessage(event.error) ?? readToolOutputText(output)
    : readToolOutputText(output);
  return [createToolEvent({
    envelope,
    context,
    source,
    state,
    phase,
    toolCallId,
    messageId,
    name: readString(event.toolName) || undefined,
    toolInput: event.input,
    partialResult: event.content,
    output,
    outputText,
    part: `tool:${toolCallId}:${phase}`,
  })];
}

function translateApprovalEvent(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
): CanonicalSessionEvent[] {
  const approval = asRecord(envelope.event.approval);
  if (!approval) return [];
  const approvalId = readString(approval.approvalId);
  if (!approvalId) return [];
  const status = asRecord(approval.status);
  const statusType = readString(status?.type);
  const approvalEvent: CanonicalApprovalEvent = {
    ...canonicalBase(envelope, context, source, `approval:${approvalId}:${statusType || 'unknown'}`),
    type: 'approval',
    approvalId,
    status: statusType === 'pending' ? 'pending' : 'resolved',
    ...(approvalDecisionForStatus(status) ? { decision: approvalDecisionForStatus(status) } : {}),
    title: readString(approval.prompt) || readString(approval.toolName) || 'Approval requested',
    ...(typeof approval.prompt === 'string' ? { command: approval.prompt } : {}),
    allowedDecisions: allowedDecisionsForApproval(approval),
    request: {
      toolCallId: readString(approval.toolCallId),
      toolName: readString(approval.toolName),
    },
    createdAtMs: Date.parse(readString(status?.requestedAt)) || Date.parse(envelope.createdAt) || Date.now(),
    ...(status && typeof status.expiresAt === 'string' ? { expiresAtMs: Date.parse(status.expiresAt) } : {}),
  };
  return [approvalEvent];
}

function createLifecycleEvent(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  phase: 'started' | 'final' | 'error' | 'aborted',
  runPhase: 'submitted' | 'done' | 'error' | 'aborted',
  error: string | null,
): CanonicalSessionEvent {
  return {
    ...canonicalBase(envelope, context, source, `lifecycle:${phase}`),
    type: 'lifecycle',
    phase,
    runPhase,
    error,
  };
}

function createUsageEvent(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  payload: unknown,
): CanonicalUsageEvent {
  return {
    ...canonicalBase(envelope, context, source, 'usage'),
    type: 'usage',
    payload,
  };
}

function canonicalBase(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  source: MatchaAgentEventSource,
  part: string,
  toolCallId?: string,
): CanonicalEventBaseFields {
  return {
    eventId: `${envelope.eventId}:${part}`,
    protocolId: MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
    source,
    sessionId: envelope.sessionId,
    ...(envelope.runId ? { runId: envelope.runId } : {}),
    seq: envelope.seq,
    timestamp: Date.parse(envelope.createdAt) || undefined,
    laneKey: `member:${context.agentId}`,
    agentId: context.agentId,
    origin: {
      runtimeEventType: envelope.event.type,
      runtimeIds: {
        sessionId: envelope.sessionId,
        ...(envelope.runId ? { runId: envelope.runId } : {}),
        ...(toolCallId ? { toolUseId: toolCallId } : {}),
        seq: String(envelope.seq),
      },
      raw: structuredClone(envelope),
    },
  };
}

function ownerBindingForMessage(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  messageId?: string,
): OwnerBinding {
  const laneKey = `member:${context.agentId}`;
  const ownerTurnKey = envelope.runId ? `run:${laneKey}:${envelope.runId}` : undefined;
  return {
    ...(ownerTurnKey ? { ownerTurnKey } : {}),
    turnBindingSource: 'runtime',
    turnBindingConfidence: 'high',
    ...(messageId ? {
      ownerMessageKey: `message:assistant:${laneKey}:${messageId}`,
      messageBindingSource: 'runtime',
      messageBindingConfidence: 'high',
    } : {}),
  };
}

function ownerBindingForTool(
  envelope: AppServerEventEnvelope,
  context: RuntimeSessionContext,
  messageId?: string,
): OwnerBinding {
  if (messageId) return ownerBindingForMessage(envelope, context, messageId);
  const laneKey = `member:${context.agentId}`;
  const ownerTurnKey = envelope.runId ? `run:${laneKey}:${envelope.runId}` : undefined;
  return {
    ...(ownerTurnKey ? {
      ownerTurnKey,
      ownerMessageKey: `${ownerTurnKey}:tools`,
    } : {}),
    turnBindingSource: 'runtime',
    turnBindingConfidence: 'high',
    messageBindingSource: 'runtime',
    messageBindingConfidence: 'high',
  };
}

function readMergedToolInput(input: unknown, inputDelta: string | undefined): unknown {
  if (!inputDelta) return input;
  const parsedDelta = parseJsonObject(inputDelta);
  if (!parsedDelta) return input;
  const inputRecord = asRecord(input);
  return inputRecord ? { ...inputRecord, ...parsedDelta } : parsedDelta;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function readSdkMessageId(
  envelope: AppServerEventEnvelope,
  sdkMessage: Record<string, unknown>,
  projectionHints: Record<string, unknown> | null,
): string {
  const message = asRecord(sdkMessage.message);
  return readString(projectionHints?.messageId)
    || readString(message?.id)
    || readString(sdkMessage.uuid)
    || `${envelope.eventId}:sdk-message`;
}

function readSdkMessageContent(sdkMessage: Record<string, unknown>): unknown[] {
  const message = asRecord(sdkMessage.message);
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(sdkMessage.content)) return sdkMessage.content;
  return [];
}

function readTextBlockText(block: unknown): string[] {
  const record = asRecord(block);
  if (record?.type !== 'text') return [];
  const text = readTextContent(record.text);
  return text !== null ? [text] : [];
}

function readTextContent(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readToolUseBlockToolCallId(block: Record<string, unknown>, projectionHints: Record<string, unknown> | null): string {
  return readString(block.id) || readString(block.toolCallId) || readString(block.tool_use_id) || readString(projectionHints?.toolCallId);
}

function readToolResultBlockToolCallId(block: Record<string, unknown>, projectionHints: Record<string, unknown> | null): string {
  return readString(block.tool_use_id) || readString(block.toolCallId) || readString(projectionHints?.toolCallId) || readString(block.id);
}

function readToolProgressToolCallId(sdkMessage: Record<string, unknown>, projectionHints: Record<string, unknown> | null): string {
  return readString(projectionHints?.toolCallId)
    || readString(sdkMessage.toolCallId)
    || readString(sdkMessage.tool_use_id)
    || readString(sdkMessage.toolUseId)
    || readString(sdkMessage.id);
}

function readToolName(record: Record<string, unknown>): string | undefined {
  return readString(record.name) || readString(record.toolName) || undefined;
}

function readToolResultOutput(block: Record<string, unknown>): unknown {
  return readFirstDefined(block.content, block.output, block.result, block.error);
}

function isToolResultError(block: Record<string, unknown>): boolean {
  return block.is_error === true || block.error !== undefined || readString(block.status) === 'error';
}

function readToolOutputText(value: unknown): string | undefined {
  const text = readTextContent(value);
  if (text !== null) return text;
  if (Array.isArray(value)) {
    const textBlocks = value.flatMap(readTextBlockText).join('');
    return textBlocks || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const recordText = readTextContent(record.text) ?? readTextContent(record.message) ?? readTextContent(record.content);
  return recordText ?? undefined;
}

function readFirstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function isAppServerEventEnvelope(value: unknown): value is AppServerEventEnvelope {
  const record = asRecord(value);
  const event = asRecord(record?.event);
  return !!record
    && typeof record.eventId === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.seq === 'number'
    && Number.isFinite(record.seq)
    && typeof record.createdAt === 'string'
    && !!event
    && typeof event.type === 'string';
}

function allowedDecisionsForApproval(approval: Record<string, unknown>): ReadonlyArray<SessionApprovalDecision> {
  const options = Array.isArray(approval.options) ? approval.options : [];
  const decisions = new Set<SessionApprovalDecision>();
  for (const option of options) {
    const optionRecord = asRecord(option);
    const kind = readString(optionRecord?.kind);
    if (kind === 'allow_once') decisions.add('allow-once');
    if (kind === 'allow_always') decisions.add('allow-always');
    if (kind === 'reject_once' || kind === 'reject_always') decisions.add('deny');
  }
  return decisions.size > 0 ? Array.from(decisions) : ['allow-once', 'deny'];
}

function approvalDecisionForStatus(status: Record<string, unknown> | null): SessionApprovalDecision | undefined {
  const statusType = readString(status?.type);
  if (statusType === 'approved') {
    return readString(status?.optionId) === 'allow_always' ? 'allow-always' : 'allow-once';
  }
  if (statusType === 'denied') return 'deny';
  return undefined;
}

function readErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return typeof value === 'string' ? value : null;
  return readString(record.message) || null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
