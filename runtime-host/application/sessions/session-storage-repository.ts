import { dirname, join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';

export interface SessionStorageDescriptor {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  sessionStoreEntry: Record<string, unknown> | null;
  transcriptPath: string | null;
}

export interface SessionTranscriptFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SessionStorageRepositoryDeps {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  fileSystem: RuntimeFileSystemPort;
}

export interface SessionStoragePort {
  listStorageDescriptors(): Promise<SessionStorageDescriptor[]>;
  findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null>;
  getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null>;
  readTranscriptContent(sessionKey: string): Promise<string | null>;
  readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null>;
  deleteSessionStorage(
    sessionKey: string,
    resolveDeletedPath?: (path: string) => string,
  ): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function resolveIndexedTranscriptPath(
  entry: Record<string, unknown>,
  sessionsDir: string,
): string | null {
  const indexedPath = entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path;
  if (typeof indexedPath === 'string' && indexedPath.trim()) {
    const normalizedPath = indexedPath.trim();
    if (isAbsolutePath(normalizedPath)) {
      return normalizedPath;
    }
    const normalizedFileName = normalizedPath.endsWith('.jsonl') ? normalizedPath : `${normalizedPath}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  const sessionId = entry.id ?? entry.sessionId;
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const normalizedFileName = sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  return null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonRecordFromFileSystem(
  fileSystem: RuntimeFileSystemPort,
  pathname: string,
): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonRecord(await fileSystem.readTextFile(pathname));
  } catch {
    return null;
  }
}

function listAgentStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string;
  sessionsJson: Record<string, unknown>;
}): SessionStorageDescriptor[] {
  const descriptors: SessionStorageDescriptor[] = [];

  if (Array.isArray(input.sessionsJson.sessions)) {
    for (const candidate of input.sessionsJson.sessions) {
      if (!isRecord(candidate)) {
        continue;
      }
      const sessionKey = normalizeString(candidate.key ?? candidate.sessionKey);
      if (!sessionKey) {
        continue;
      }
      descriptors.push({
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        sessionStoreEntry: candidate,
        transcriptPath: resolveIndexedTranscriptPath(candidate, input.sessionsDir),
      });
    }
    return descriptors;
  }

  for (const [sessionKey, value] of Object.entries(input.sessionsJson)) {
    if (!sessionKey.startsWith('agent:')) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalizedFileName = value.endsWith('.jsonl') ? value : `${value}.jsonl`;
      descriptors.push({
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        sessionStoreEntry: null,
        transcriptPath: join(input.sessionsDir, normalizedFileName),
      });
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    descriptors.push({
      sessionKey,
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      sessionStoreEntry: value,
      transcriptPath: resolveIndexedTranscriptPath(value, input.sessionsDir),
    });
  }

  return descriptors;
}

function normalizeTranscriptFileName(fileName: string): string | null {
  const normalized = normalizeString(fileName);
  if (!normalized.endsWith('.jsonl') || normalized.endsWith('.deleted.jsonl')) {
    return null;
  }
  return normalized;
}

function buildFallbackSessionKey(agentId: string, transcriptFileName: string): string {
  const suffix = transcriptFileName.slice(0, -'.jsonl'.length);
  return `agent:${agentId}:${suffix}`;
}

function listTranscriptStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  entryNames: readonly string[];
  indexedDescriptors?: readonly SessionStorageDescriptor[];
}): SessionStorageDescriptor[] {
  const indexedTranscriptPaths = new Set(
    (input.indexedDescriptors ?? [])
      .map((descriptor) => normalizeString(descriptor.transcriptPath))
      .filter((path): path is string => path.length > 0),
  );
  const descriptors: SessionStorageDescriptor[] = [];

  for (const entryName of input.entryNames) {
    const transcriptFileName = normalizeTranscriptFileName(entryName);
    if (!transcriptFileName) {
      continue;
    }
    const transcriptPath = join(input.sessionsDir, transcriptFileName);
    if (indexedTranscriptPaths.has(transcriptPath)) {
      continue;
    }
    descriptors.push({
      sessionKey: buildFallbackSessionKey(input.agentId, transcriptFileName),
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      sessionStoreEntry: null,
      transcriptPath,
    });
  }

  return descriptors;
}

function pruneStorageIndex(
  sessionsJson: Record<string, unknown>,
  sessionKey: string,
): Record<string, unknown> {
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

  return Object.fromEntries(
    Object.entries(sessionsJson).filter(([candidateKey]) => candidateKey !== sessionKey),
  );
}

export class SessionStorageRepository implements SessionStoragePort {
  constructor(private readonly deps: SessionStorageRepositoryDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    const agentsDir = join(this.deps.workspace.getConfigDir(), 'agents');
    let agentEntries: Array<{ isDirectory: boolean; name: string }>;
    try {
      agentEntries = await this.deps.fileSystem.listDirectory(agentsDir);
    } catch {
      return [];
    }

    const descriptors: SessionStorageDescriptor[] = [];
    for (const agentDirEntry of agentEntries) {
      if (!agentDirEntry.isDirectory) {
        continue;
      }
      const agentId = agentDirEntry.name;
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const sessionsJson = await readJsonRecordFromFileSystem(this.deps.fileSystem, sessionsJsonPath);
      const indexedDescriptors = sessionsJson ? listAgentStorageDescriptors({
        agentId,
        sessionsDir,
        sessionsJsonPath,
        sessionsJson,
      }) : [];

      let entryNames: string[] = [];
      try {
        entryNames = (await this.deps.fileSystem.listDirectory(sessionsDir))
          .filter((entry) => entry.isFile)
          .map((entry) => entry.name);
      } catch {
        entryNames = [];
      }
      descriptors.push(...indexedDescriptors);
      descriptors.push(...listTranscriptStorageDescriptors({
        agentId,
        sessionsDir,
        sessionsJsonPath: sessionsJson ? sessionsJsonPath : null,
        sessionsJson,
        entryNames,
        indexedDescriptors,
      }));
    }
    return descriptors;
  }

  async findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null> {
    if (!sessionKey.startsWith('agent:')) {
      return null;
    }
    for (const descriptor of await this.listStorageDescriptors()) {
      if (descriptor.sessionKey === sessionKey) {
        return descriptor;
      }
    }
    return null;
  }

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

  async readTranscriptContent(sessionKey: string): Promise<string | null> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    return descriptor ? await this.readTranscriptDescriptorContent(descriptor) : null;
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

  async deleteSessionStorage(
    sessionKey: string,
    resolveDeletedPath?: (path: string) => string,
  ): Promise<boolean> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    if (!descriptor) {
      return false;
    }

    if (descriptor.transcriptPath && await this.deps.fileSystem.exists(descriptor.transcriptPath)) {
      const deletedPath = resolveDeletedPath?.(descriptor.transcriptPath);
      if (deletedPath && deletedPath !== descriptor.transcriptPath) {
        await this.deps.fileSystem.ensureDirectory(dirname(deletedPath));
        await this.deps.fileSystem.rename(descriptor.transcriptPath, deletedPath);
      } else {
        await this.deps.fileSystem.removeFile(descriptor.transcriptPath);
      }
    }

    if (descriptor.sessionsJson && descriptor.sessionsJsonPath) {
      const nextSessionsJson = pruneStorageIndex(descriptor.sessionsJson, sessionKey);
      await this.deps.fileSystem.writeTextFile(
        descriptor.sessionsJsonPath,
        JSON.stringify(nextSessionsJson, null, 2),
      );
    }

    return true;
  }

}
