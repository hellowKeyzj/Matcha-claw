import type { GatewayChatPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import { iterateTranscriptMessages } from '../../transcript-parser';
import { iterateCanonicalReplayEventsFromTranscriptMessages } from '../../canonical/canonical-transcript-replay';
import { OpenClawV4Adapter } from '../../canonical/providers/openclaw-v4-adapter';
import { buildFallbackRuntimeMessageId } from '../runtime-identity-contract';
import type {
  RuntimeEventAdapter,
  RuntimeProtocolAdapter,
  RuntimeProviderProfile,
  RuntimeReplayAdapter,
  RuntimeSessionContext,
  RuntimeSessionTransport,
} from '../runtime-provider-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_PROVIDER_ID } from '../runtime-provider-types';
import { OpenClawRuntimeTransport } from './openclaw-transport';

class OpenClawV4RuntimeEventAdapter implements RuntimeEventAdapter {
  private readonly adapter = new OpenClawV4Adapter();

  canTranslate(input: unknown, context: RuntimeSessionContext): boolean {
    return context.protocolId === OPENCLAW_RUNTIME_PROTOCOL_ID && input !== null && typeof input === 'object';
  }

  translate(input: unknown): ReturnType<RuntimeEventAdapter['translate']> {
    return this.adapter.translate(input as Parameters<OpenClawV4Adapter['translate']>[0]);
  }
}

class OpenClawV4RuntimeReplayAdapter implements RuntimeReplayAdapter {
  replayTranscript(sessionKey: string, transcript: unknown): ReturnType<RuntimeReplayAdapter['replayTranscript']> {
    const messages = typeof transcript === 'string' ? iterateTranscriptMessages(transcript) : [];
    return iterateCanonicalReplayEventsFromTranscriptMessages(sessionKey, messages);
  }
}

export class OpenClawV4ProtocolAdapter implements RuntimeProtocolAdapter {
  readonly protocolId = OPENCLAW_RUNTIME_PROTOCOL_ID;
  readonly eventAdapter: RuntimeEventAdapter = new OpenClawV4RuntimeEventAdapter();
  readonly replayAdapter: RuntimeReplayAdapter = new OpenClawV4RuntimeReplayAdapter();
  readonly identityPolicy = {
    buildMessageId: (input: Parameters<RuntimeProtocolAdapter['identityPolicy']['buildMessageId']>[0]) => buildFallbackRuntimeMessageId({
      ...input,
      runtimeProviderId: OPENCLAW_RUNTIME_PROVIDER_ID,
    }),
  };

  constructor(private readonly gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>) {}

  createTransport(_profile: RuntimeProviderProfile): RuntimeSessionTransport {
    return new OpenClawRuntimeTransport(this.gateway);
  }
}
