import type { CanonicalSessionEvent } from './canonical/canonical-events';
import type { RuntimeSessionContext } from '../agent-runtime/contracts/runtime-endpoint-types';
import type { SessionStoragePort } from './session-storage-repository';
import { AgentRuntimeRegistry } from '../agent-runtime/contracts/agent-runtime-registry';

interface SessionTranscriptTimelineLoaderDeps {
  sessionStorage: SessionStoragePort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
}

export class SessionTranscriptTimelineLoader {
  constructor(private readonly deps: SessionTranscriptTimelineLoaderDeps) {}

  async readCanonicalReplayEvents(context: RuntimeSessionContext): Promise<AsyncIterable<CanonicalSessionEvent> | Iterable<CanonicalSessionEvent>> {
    const lines = await this.readTranscriptLines(context);
    const registry = this.deps.agentRuntimeRegistry;
    const protocol = registry.getProtocol(context.protocolId);
    return protocol.replayAdapter.replayTranscript(context.sessionKey, lines, context);
  }

  private async readTranscriptLines(context: RuntimeSessionContext): Promise<AsyncIterable<string>> {
    const endpointSessionId = context.endpointSessionId.trim();
    if (endpointSessionId && endpointSessionId !== context.identity.sessionKey) {
      const endpointDescriptor = await this.deps.sessionStorage.findStorageDescriptor({
        ...context.identity,
        sessionKey: endpointSessionId,
      });
      if (endpointDescriptor) {
        return this.deps.sessionStorage.readTranscriptDescriptorLines(endpointDescriptor);
      }
    }
    return this.deps.sessionStorage.readTranscriptLines(context.identity);
  }

}
