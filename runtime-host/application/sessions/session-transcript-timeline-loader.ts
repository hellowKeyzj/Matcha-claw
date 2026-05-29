import type { CanonicalSessionEvent } from './canonical/canonical-events';
import { iterateCanonicalReplayEventsFromTranscriptMessages } from './canonical/canonical-transcript-replay';
import {
  iterateTranscriptMessages,
} from './transcript-parser';
import type { SessionStoragePort } from './session-storage-repository';

interface SessionTranscriptTimelineLoaderDeps {
  sessionStorage: SessionStoragePort;
}

export class SessionTranscriptTimelineLoader {
  constructor(private readonly deps: SessionTranscriptTimelineLoaderDeps) {}

  async readCanonicalReplayEvents(sessionId: string): Promise<Iterable<CanonicalSessionEvent>> {
    const content = await this.deps.sessionStorage.readTranscriptContent(sessionId);
    return iterateCanonicalReplayEventsFromTranscriptMessages(
      sessionId,
      content ? iterateTranscriptMessages(content) : [],
    );
  }

}
