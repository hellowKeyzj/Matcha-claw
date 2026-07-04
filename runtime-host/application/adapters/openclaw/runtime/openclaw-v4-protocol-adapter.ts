import { iterateTranscriptMessages, iterateTranscriptMessagesAsync } from '../../../sessions/transcript-parser';
import {
  iterateCanonicalReplayEventsFromTranscriptMessages,
  iterateCanonicalReplayEventsFromTranscriptMessagesAsync,
} from '../../../sessions/canonical/canonical-transcript-replay';
import { OpenClawV4Adapter } from './openclaw-v4-canonical-adapter';
import { buildSessionIdentityScopedMessageId } from '../../../agent-runtime/contracts/runtime-identity-contract';
import type {
  RuntimeEventAdapter,
  RuntimeProtocolAdapter,
  RuntimeReplayAdapter,
  RuntimeSessionContext,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import type { SessionTranscriptMessage } from '../../../sessions/transcript-types';
import { OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_PROTOCOL_ID } from './openclaw-runtime-identity';

function stripTeamRunPromptEnvelopeText(text: string): string {
  return stripTeamRunWorkspaceContextText(text)
    ?? stripTeamRunPromptEnvelopeSection(text, {
      marker: '### Attempt user message',
      description: 'This user message started this entry WorkNode attempt. Treat it as the attempt input, not as generic chat history.',
      stopMarker: '### Node work\n\nThis is the work instruction from the node config, workflow task, or node title. Do this work; do not treat it as tool documentation.',
    })
    ?? stripTeamRunPromptEnvelopeSection(text, {
      marker: '## Team chat message',
      description: 'Use this user message as the latest input for this TeamRun node.',
      stopMarker: undefined,
    })
    ?? text;
}

function stripTeamRunWorkspaceContextText(text: string): string | null {
  const marker = '### TeamRun workspace context';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const contextText = text.slice(markerIndex + marker.length);
  if (!contextText.includes('This message is for the long-lived Team role workspace session. It is not a WorkNode attempt prompt and does not claim a nodeExecutionId.')) {
    return null;
  }
  return text.slice(0, markerIndex).trim();
}

function stripTeamRunPromptEnvelopeSection(text: string, input: {
  readonly marker: string;
  readonly description: string;
  readonly stopMarker: string | undefined;
}): string | null {
  const markerIndex = text.indexOf(input.marker);
  if (markerIndex < 0) {
    return null;
  }
  const prefix = text.slice(0, markerIndex);
  const hasTeamRunEnvelope = /(^|\n)\s*#\s*TeamRun node prompt\b/i.test(prefix)
    || /(^|\n)\s*##\s*TeamRun (?:WorkNode|ReviewNode):/i.test(prefix)
    || /(^|\n)\s*##\s*Delivery envelope\b/i.test(prefix);
  if (!hasTeamRunEnvelope) {
    return null;
  }
  const sectionText = text.slice(markerIndex + input.marker.length)
    .replace(input.description, '')
    .trim();
  if (!input.stopMarker) {
    return sectionText;
  }
  const stopMarkerIndex = sectionText.indexOf(input.stopMarker);
  return (stopMarkerIndex < 0 ? sectionText : sectionText.slice(0, stopMarkerIndex)).trim();
}

function stripTeamRunPromptEnvelopeContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return stripTeamRunPromptEnvelopeText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return block;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== 'text' || typeof record.text !== 'string') {
      return block;
    }
    const nextText = stripTeamRunPromptEnvelopeText(record.text);
    if (nextText === record.text) {
      return block;
    }
    changed = true;
    return {
      ...record,
      text: nextText,
    };
  });

  return changed ? nextContent : content;
}

function stripOpenClawTeamRunPromptEnvelope(message: SessionTranscriptMessage): SessionTranscriptMessage {
  if (message.role !== 'user') {
    return message;
  }
  const nextContent = stripTeamRunPromptEnvelopeContent(message.content);
  const nextText = typeof message.text === 'string'
    ? stripTeamRunPromptEnvelopeText(message.text)
    : message.text;
  if (nextContent === message.content && nextText === message.text) {
    return message;
  }
  return {
    ...message,
    content: nextContent,
    ...(typeof nextText === 'string' ? { text: nextText } : {}),
  };
}

function* stripOpenClawTeamRunPromptEnvelopeMessages(
  messages: Iterable<SessionTranscriptMessage>,
): Iterable<SessionTranscriptMessage> {
  for (const message of messages) {
    yield stripOpenClawTeamRunPromptEnvelope(message);
  }
}

async function* stripOpenClawTeamRunPromptEnvelopeMessagesAsync(
  messages: AsyncIterable<SessionTranscriptMessage>,
): AsyncIterable<SessionTranscriptMessage> {
  for await (const message of messages) {
    yield stripOpenClawTeamRunPromptEnvelope(message);
  }
}

class OpenClawV4RuntimeEventAdapter implements RuntimeEventAdapter {
  private readonly adapter = new OpenClawV4Adapter();

  canTranslate(input: unknown, context: RuntimeSessionContext): boolean {
    return context.protocolId === OPENCLAW_RUNTIME_PROTOCOL_ID && input !== null && typeof input === 'object';
  }

  translate(input: unknown, context: RuntimeSessionContext): ReturnType<RuntimeEventAdapter['translate']> {
    return this.adapter.translate(stripOpenClawTeamRunPromptEnvelopeEvent(input) as Parameters<OpenClawV4Adapter['translate']>[0], context);
  }
}

function stripOpenClawTeamRunPromptEnvelopeEvent(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const eventInput = input as OpenClawV4ConversationEvent;
  if (eventInput.type !== 'session.message') {
    return input;
  }
  const message = eventInput.event.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return input;
  }
  const nextMessage = stripOpenClawTeamRunPromptEnvelope(message as SessionTranscriptMessage);
  if (nextMessage === message) {
    return input;
  }
  return {
    ...eventInput,
    event: {
      ...eventInput.event,
      message: nextMessage,
    },
  };
}

class OpenClawV4RuntimeReplayAdapter implements RuntimeReplayAdapter {
  replayTranscript(sessionKey: string, transcript: Parameters<RuntimeReplayAdapter['replayTranscript']>[1]): ReturnType<RuntimeReplayAdapter['replayTranscript']> {
    const identity = {
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    };
    if (typeof transcript === 'string' || Symbol.iterator in Object(transcript)) {
      return iterateCanonicalReplayEventsFromTranscriptMessages(
        sessionKey,
        stripOpenClawTeamRunPromptEnvelopeMessages(iterateTranscriptMessages(transcript as string | Iterable<string>)),
        identity,
      );
    }
    return iterateCanonicalReplayEventsFromTranscriptMessagesAsync(
      sessionKey,
      stripOpenClawTeamRunPromptEnvelopeMessagesAsync(iterateTranscriptMessagesAsync(transcript)),
      identity,
    );
  }
}

export class OpenClawV4ProtocolAdapter implements RuntimeProtocolAdapter {
  readonly protocolId = OPENCLAW_RUNTIME_PROTOCOL_ID;
  readonly eventAdapter: RuntimeEventAdapter = new OpenClawV4RuntimeEventAdapter();
  readonly replayAdapter: RuntimeReplayAdapter = new OpenClawV4RuntimeReplayAdapter();
  readonly identityPolicy = {
    buildMessageId: (input: Parameters<RuntimeProtocolAdapter['identityPolicy']['buildMessageId']>[0]) => buildSessionIdentityScopedMessageId(input),
  };

}
