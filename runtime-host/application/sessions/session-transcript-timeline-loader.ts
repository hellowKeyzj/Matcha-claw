import type {
  SessionTimelineEntry,
  TaskSnapshotEvent,
} from '../../shared/session-adapter-types';
import {
  materializeTranscriptTimelineEntries,
} from './transcript-timeline-materializer';
import {
  parseTranscriptMessages,
} from './transcript-parser';
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
}
