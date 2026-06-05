import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { SessionStorageDescriptor, SessionTranscriptFingerprint } from '../../sessions/session-storage-repository';

export interface SessionStorageTranscriptWorkflowDeps {
  readonly fileSystem: RuntimeFileSystemPort;
}

export class SessionStorageTranscriptWorkflow {
  constructor(private readonly deps: SessionStorageTranscriptWorkflowDeps) {}

  async getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null> {
    try {
      const fileStat = await this.deps.fileSystem.stat(pathname);
      if (!fileStat.isFile) {
        return null;
      }
      return {
        path: pathname,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null> {
    if (!descriptor?.transcriptPath || !(await this.deps.fileSystem.exists(descriptor.transcriptPath))) {
      return null;
    }

    try {
      return await this.deps.fileSystem.readTextFile(descriptor.transcriptPath);
    } catch {
      return null;
    }
  }

  async *readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string> {
    if (!descriptor?.transcriptPath || !(await this.deps.fileSystem.exists(descriptor.transcriptPath))) {
      return;
    }

    try {
      yield* this.deps.fileSystem.readTextFileLines(descriptor.transcriptPath);
    } catch {
      return;
    }
  }
}
