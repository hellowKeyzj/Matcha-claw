import { basename, dirname, isAbsolute, join, relative, win32 } from 'node:path';
import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { RuntimeDirectoryEntry, RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { SessionExternalArtefactResolverPort, SessionStorageDescriptor } from '../../sessions/session-storage-repository';

export interface SessionStorageMutationWorkflowDeps {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly externalArtefactResolver?: SessionExternalArtefactResolverPort;
}

export class SessionStorageMutationWorkflow {
  constructor(private readonly deps: SessionStorageMutationWorkflowDeps) {}

  async upsertSessionIdentity(
    descriptor: SessionStorageDescriptor,
    sessionKey: string,
    sessionIdentity: SessionIdentity,
  ): Promise<void> {
    await this.writeSessionIndex(descriptor, updateStorageIndexSessionIdentity(descriptor.sessionsJson, sessionKey, sessionIdentity));
  }

  async updateStatus(
    descriptor: SessionStorageDescriptor,
    sessionKey: string,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<void> {
    await this.writeSessionIndex(descriptor, updateStorageIndexStatus(descriptor.sessionsJson, sessionKey, status));
  }

  async rename(
    descriptor: SessionStorageDescriptor,
    sessionKey: string,
    label: string,
  ): Promise<void> {
    await this.writeSessionIndex(descriptor, updateStorageIndexLabel(descriptor.sessionsJson, sessionKey, label));
  }

  async delete(descriptor: SessionStorageDescriptor, sessionKey: string): Promise<void> {
    if (descriptor.transcriptPath) {
      await this.removeSessionArtefacts(descriptor);
    }
    await this.writeSessionIndex(descriptor, removeSessionFromStorageIndex(descriptor.sessionsJson, sessionKey));
  }

  private async writeSessionIndex(descriptor: SessionStorageDescriptor, sessionsJson: Record<string, unknown> | null): Promise<void> {
    if (!descriptor.sessionsJsonPath || !sessionsJson) {
      return;
    }
    await this.deps.fileSystem.writeTextFile(
      descriptor.sessionsJsonPath,
      JSON.stringify(sessionsJson, null, 2),
    );
  }

  private async removeSessionArtefacts(descriptor: SessionStorageDescriptor): Promise<void> {
    if (!descriptor.transcriptPath) {
      return;
    }
    const baseId = readTranscriptBaseId(descriptor.transcriptPath);
    if (!baseId) {
      return;
    }
    const transcriptDir = dirname(descriptor.transcriptPath);
    if (!isPathInside(descriptor.sessionsDir, transcriptDir)) {
      return;
    }

    let entries: RuntimeDirectoryEntry[] = [];
    try {
      entries = await this.deps.fileSystem.listDirectory(transcriptDir);
    } catch {
      return;
    }

    const localTargets = entries
      .filter((entry) => entry.isFile && isSessionArtefactName(entry.name, baseId))
      .map((entry) => join(transcriptDir, entry.name));

    const pointerPath = join(transcriptDir, `${baseId}.trajectory-path.json`);
    if (localTargets.includes(pointerPath)) {
      await this.removeExternalTrajectory(pointerPath, transcriptDir);
    }

    await Promise.all(localTargets.map((target) => this.deps.fileSystem.removeFile(target)));
  }

  private async removeExternalTrajectory(pointerPath: string, transcriptDir: string): Promise<void> {
    const resolver = this.deps.externalArtefactResolver;
    if (!resolver) {
      return;
    }
    let pointerContent = '';
    try {
      pointerContent = await this.deps.fileSystem.readTextFile(pointerPath);
    } catch {
      return;
    }
    const targets = resolver.resolveExternalArtefactPaths({ pointerPath, pointerContent, transcriptDir });
    await Promise.all(targets
      .filter((target) => isAbsolutePath(target) && !isPathInside(transcriptDir, target))
      .map((target) => this.deps.fileSystem.removeFile(target)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function updateStorageIndexEntry(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!sessionsJson) {
    return null;
  }
  if (Array.isArray(sessionsJson.sessions)) {
    let found = false;
    const sessions = sessionsJson.sessions.map((candidate) => {
      if (!isRecord(candidate)) {
        return candidate;
      }
      const candidateKey = normalizeString(candidate.key ?? candidate.sessionKey);
      if (candidateKey !== sessionKey) {
        return candidate;
      }
      found = true;
      return { ...candidate, ...patch };
    });
    return found
      ? { ...sessionsJson, sessions }
      : { ...sessionsJson, sessions: [...sessionsJson.sessions, { key: sessionKey, ...patch }] };
  }

  const current = sessionsJson[sessionKey];
  if (isRecord(current)) {
    return {
      ...sessionsJson,
      [sessionKey]: { ...current, ...patch },
    };
  }
  if (typeof current === 'string' && current.trim()) {
    return {
      ...sessionsJson,
      [sessionKey]: { file: current, ...patch },
    };
  }
  return {
    ...sessionsJson,
    [sessionKey]: { key: sessionKey, ...patch },
  };
}

function updateStorageIndexStatus(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
  status: 'active' | 'completed' | 'archived' | 'deleted',
): Record<string, unknown> | null {
  return updateStorageIndexEntry(sessionsJson, sessionKey, { status });
}

function removeSessionFromStorageIndex(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
): Record<string, unknown> | null {
  if (!sessionsJson) {
    return null;
  }
  if (Array.isArray(sessionsJson.sessions)) {
    return {
      ...sessionsJson,
      sessions: sessionsJson.sessions.filter((candidate) => {
        if (!isRecord(candidate)) {
          return true;
        }
        const candidateKey = normalizeString(candidate.key ?? candidate.sessionKey);
        return candidateKey !== sessionKey;
      }),
    };
  }
  const next = { ...sessionsJson };
  delete next[sessionKey];
  return next;
}

function updateStorageIndexLabel(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
  label: string,
): Record<string, unknown> | null {
  return updateStorageIndexEntry(sessionsJson, sessionKey, { label });
}

function updateStorageIndexSessionIdentity(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
  sessionIdentity: SessionIdentity,
): Record<string, unknown> | null {
  return updateStorageIndexEntry(sessionsJson, sessionKey, { sessionIdentity });
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const rel = relative(parentDir, childPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolutePath(rel));
}

function readTranscriptBaseId(transcriptPath: string): string | null {
  const fileName = basename(transcriptPath);
  return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : null;
}

function isSessionArtefactName(fileName: string, baseId: string): boolean {
  return fileName === `${baseId}.jsonl`
    || fileName === `${baseId}.deleted.jsonl`
    || fileName === `${baseId}.trajectory.jsonl`
    || fileName === `${baseId}.trajectory-path.json`
    || fileName.startsWith(`${baseId}.jsonl.reset.`);
}
