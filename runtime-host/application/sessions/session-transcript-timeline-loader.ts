import type {
  TaskSnapshotEvent,
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
import {
  extractLatestTaskSnapshotFromTranscriptMessages,
} from './transcript-task-snapshot-replay';
import type { SessionStoragePort } from './session-storage-repository';

export interface SessionTranscriptReplay {
  timelineEntries: SessionTimelineEntry[];
  taskSnapshot: TaskSnapshotEvent | null;
}

interface SessionTranscriptTimelineLoaderDeps {
  sessionStorage: SessionStoragePort;
}

export class SessionTranscriptTimelineLoader {
  constructor(private readonly deps: SessionTranscriptTimelineLoaderDeps) {}

  async readTimelineEntries(sessionKey: string): Promise<SessionTimelineEntry[]> {
    return (await this.readTimelineReplay(sessionKey)).timelineEntries;
  }

  async readTimelineReplay(sessionKey: string): Promise<SessionTranscriptReplay> {
    const content = await this.deps.sessionStorage.readTranscriptContent(sessionKey);
    if (!content) {
      return {
        timelineEntries: [],
        taskSnapshot: null,
      };
    }
    const messages = parseTranscriptMessages(content);
    return {
      timelineEntries: materializeTranscriptTimelineEntries(sessionKey, messages),
      taskSnapshot: extractLatestTaskSnapshotFromTranscriptMessages(sessionKey, messages),
    };
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
