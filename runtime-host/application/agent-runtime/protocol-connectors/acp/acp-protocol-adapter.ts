import type { CanonicalSessionEvent } from '../../../sessions/canonical/canonical-events';
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

  async *replayTranscript(_sessionKey: string, transcript: unknown, context: RuntimeSessionContext): AsyncIterable<CanonicalSessionEvent> {
    for await (const line of this.readLines(transcript)) {
      const payload = this.parseLine(line);
      if (!payload) {
        continue;
      }
      yield* this.eventAdapter.translate(payload, context);
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
