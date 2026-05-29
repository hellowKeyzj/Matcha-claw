import type { CanonicalSessionEvent } from './canonical/canonical-events';
import type { SessionStoragePort } from './session-storage-repository';
import { RuntimeProviderRegistry } from './runtime-providers/runtime-provider-registry';

interface SessionTranscriptTimelineLoaderDeps {
  sessionStorage: SessionStoragePort;
  runtimeProviderRegistry: RuntimeProviderRegistry;
}

export class SessionTranscriptTimelineLoader {
  constructor(private readonly deps: SessionTranscriptTimelineLoaderDeps) {}

  async readCanonicalReplayEvents(sessionId: string): Promise<Iterable<CanonicalSessionEvent>> {
    const content = await this.deps.sessionStorage.readTranscriptContent(sessionId);
    const registry = this.deps.runtimeProviderRegistry;
    const context = registry.resolveSessionContext(sessionId);
    const protocol = registry.getProtocol(context.protocolId);
    return protocol.replayAdapter.replayTranscript(sessionId, content ?? '', context);
  }

}
