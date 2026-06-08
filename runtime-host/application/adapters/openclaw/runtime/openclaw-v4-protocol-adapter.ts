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
import { OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_PROTOCOL_ID } from './openclaw-runtime-identity';

class OpenClawV4RuntimeEventAdapter implements RuntimeEventAdapter {
  private readonly adapter = new OpenClawV4Adapter();

  canTranslate(input: unknown, context: RuntimeSessionContext): boolean {
    return context.protocolId === OPENCLAW_RUNTIME_PROTOCOL_ID && input !== null && typeof input === 'object';
  }

  translate(input: unknown, context: RuntimeSessionContext): ReturnType<RuntimeEventAdapter['translate']> {
    return this.adapter.translate(input as Parameters<OpenClawV4Adapter['translate']>[0], context);
  }
}

class OpenClawV4RuntimeReplayAdapter implements RuntimeReplayAdapter {
  replayTranscript(sessionKey: string, transcript: Parameters<RuntimeReplayAdapter['replayTranscript']>[1]): ReturnType<RuntimeReplayAdapter['replayTranscript']> {
    const identity = {
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    };
    if (typeof transcript === 'string' || Symbol.iterator in Object(transcript)) {
      return iterateCanonicalReplayEventsFromTranscriptMessages(sessionKey, iterateTranscriptMessages(transcript as string | Iterable<string>), identity);
    }
    return iterateCanonicalReplayEventsFromTranscriptMessagesAsync(sessionKey, iterateTranscriptMessagesAsync(transcript), identity);
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
