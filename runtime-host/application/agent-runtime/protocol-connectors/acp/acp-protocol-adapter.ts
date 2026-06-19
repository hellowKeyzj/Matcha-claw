import type { CanonicalSessionEvent } from '../../../sessions/canonical/canonical-events';
import { iterateCanonicalReplayEventsFromTranscriptMessages } from '../../../sessions/canonical/canonical-transcript-replay';
import { iterateTranscriptMessages } from '../../../sessions/transcript-parser';
import type { SessionTranscriptMessage } from '../../../sessions/transcript-types';
import { buildSessionIdentityScopedMessageId } from '../../contracts/runtime-identity-contract';
import type {
  RuntimeProtocolAdapter,
  RuntimeReplayAdapter,
  RuntimeSessionContext,
} from '../../contracts/runtime-endpoint-types';
import { AcpCanonicalAdapter } from './acp-canonical-adapter';
import { ACP_PROTOCOL_ID } from './acp-identity';

class AcpReplayAdapter implements RuntimeReplayAdapter {
  constructor(private readonly eventAdapter: AcpCanonicalAdapter) {}

  async *replayTranscript(sessionKey: string, transcript: unknown, context: RuntimeSessionContext): AsyncIterable<CanonicalSessionEvent> {
    const transcriptMessages: SessionTranscriptMessage[] = [];
    const acpPayloads: unknown[] = [];
    for await (const line of this.readLines(transcript)) {
      const message = Array.from(iterateTranscriptMessages([line]))[0];
      if (message) {
        transcriptMessages.push(message);
        continue;
      }
      const payload = this.parseLine(line);
      if (payload) {
        acpPayloads.push(payload);
      }
    }

    if (transcriptMessages.length > 0) {
      yield* iterateCanonicalReplayEventsFromTranscriptMessages(sessionKey, transcriptMessages, {
        protocolId: context.protocolId,
        runtimeEndpointId: context.runtimeEndpointId,
      });
    }
    for (const payload of acpPayloads) {
      yield* this.eventAdapter.translate(this.markReplayPayload(payload), context);
    }
  }

  private async *readLines(transcript: unknown): AsyncIterable<string> {
    if (typeof transcript === 'string') {
      yield* transcript.split(/\r?\n/);
      return;
    }
    if (this.isAsyncIterable(transcript)) {
      for await (const line of transcript) {
        if (typeof line === 'string') {
          yield line;
        }
      }
      return;
    }
    if (this.isIterable(transcript)) {
      for (const line of transcript) {
        if (typeof line === 'string') {
          yield line;
        }
      }
    }
  }

  private parseLine(line: string): unknown | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  private markReplayPayload(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    const record = payload as Record<string, unknown>;
    return {
      ...record,
      source: 'replay',
    };
  }

  private isAsyncIterable(input: unknown): input is AsyncIterable<unknown> {
    return Boolean(input) && typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
  }

  private isIterable(input: unknown): input is Iterable<unknown> {
    return Boolean(input) && typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
  }
}

export class AcpProtocolAdapter implements RuntimeProtocolAdapter {
  readonly protocolId = ACP_PROTOCOL_ID;
  readonly eventAdapter = new AcpCanonicalAdapter();
  readonly replayAdapter = new AcpReplayAdapter(this.eventAdapter);
  readonly identityPolicy = {
    buildMessageId: (input: Parameters<RuntimeProtocolAdapter['identityPolicy']['buildMessageId']>[0]) => buildSessionIdentityScopedMessageId(input),
  };
}
