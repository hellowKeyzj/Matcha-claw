import type {
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  materializeTranscriptTimelineEntries,
  materializeTranscriptToolResultPatchEntries,
} from './transcript-timeline-materializer';
import {
  parseTranscriptMessages,
} from './transcript-parser';
import {
  upsertTimelineEntry,
} from './timeline-state';
import type { SessionStoragePort } from './session-storage-repository';

interface SessionTranscriptTimelineLoaderDeps {
  sessionStorage: SessionStoragePort;
}

export class SessionTranscriptTimelineLoader {
  constructor(private readonly deps: SessionTranscriptTimelineLoaderDeps) {}

  async readTimelineEntries(sessionKey: string): Promise<SessionTimelineEntry[]> {
    const content = await this.deps.sessionStorage.readTranscriptContent(sessionKey);
    if (!content) {
      return [];
    }
    return materializeTranscriptTimelineEntries(sessionKey, parseTranscriptMessages(content));
  }

  async reconcileToolResultPatchEntries(input: {
    sessionKey: string;
    existingEntries: SessionTimelineEntry[];
  }): Promise<SessionTimelineEntry[]> {
    const content = await this.deps.sessionStorage.readTranscriptContent(input.sessionKey);
    if (!content) {
      return input.existingEntries;
    }

    const transcriptMessages = parseTranscriptMessages(content);
    const toolPatchEntries = materializeTranscriptToolResultPatchEntries(
      input.sessionKey,
      transcriptMessages,
      input.existingEntries,
    );
    if (toolPatchEntries.length === 0) {
      return input.existingEntries;
    }
    let nextEntries = input.existingEntries;
    for (const entry of toolPatchEntries) {
      nextEntries = upsertTimelineEntry(nextEntries, entry);
    }
    return nextEntries;
  }
}
