import type { CanonicalSessionEvent } from '../../canonical/canonical-events';
import { buildFallbackRuntimeMessageId } from '../runtime-identity-contract';
import type {
  RuntimeProtocolAdapter,
  RuntimeProviderProfile,
  RuntimeReplayAdapter,
  RuntimeSessionContext,
  RuntimeSessionTransport,
} from '../runtime-provider-types';
import { ACP_RUNTIME_PROTOCOL_ID } from '../runtime-provider-types';
import { AcpCanonicalAdapter } from './acp-canonical-adapter';
import { AcpStdioTransport } from './acp-stdio-transport';

class AcpReplayAdapter implements RuntimeReplayAdapter {
  replayTranscript(_sessionKey: string, _transcript: unknown, _context: RuntimeSessionContext): Iterable<CanonicalSessionEvent> {
    return [];
  }
}

export class AcpProtocolAdapter implements RuntimeProtocolAdapter {
  readonly protocolId = ACP_RUNTIME_PROTOCOL_ID;
  readonly eventAdapter = new AcpCanonicalAdapter();
  readonly replayAdapter = new AcpReplayAdapter();
  readonly identityPolicy = {
    buildMessageId: (input: Parameters<RuntimeProtocolAdapter['identityPolicy']['buildMessageId']>[0]) => buildFallbackRuntimeMessageId({
      ...input,
      runtimeProviderId: input.runtimeProviderId ?? ACP_RUNTIME_PROTOCOL_ID,
    }),
  };

  createTransport(profile: RuntimeProviderProfile): RuntimeSessionTransport {
    return new AcpStdioTransport(profile);
  }
}
