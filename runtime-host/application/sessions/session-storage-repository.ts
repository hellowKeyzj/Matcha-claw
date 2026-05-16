import { join } from 'node:path';
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
  deleteSession(sessionKey: string): Promise<boolean>;
  updateSessionStatus(sessionKey: string, status: 'active' | 'completed' | 'archived' | 'deleted'): Promise<boolean>;
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

function updateStorageIndexStatus(
  sessionsJson: Record<string, unknown>,
  sessionKey: string,
  status: 'active' | 'completed' | 'archived' | 'deleted',
): Record<string, unknown> {
  if (Array.isArray(sessionsJson.sessions)) {
    return {
      ...sessionsJson,
      sessions: sessionsJson.sessions.map((candidate) => {
        if (!isRecord(candidate)) {
          return candidate;
        }
        const candidateKey = normalizeString(candidate.key ?? candidate.sessionKey);
        return candidateKey === sessionKey ? { ...candidate, status } : candidate;
      }),
    };
  }
  const current = sessionsJson[sessionKey];
  if (isRecord(current)) {
    return {
      ...sessionsJson,
      [sessionKey]: { ...current, status },
    };
  }
  if (typeof current === 'string') {
    return {
      ...sessionsJson,
      [sessionKey]: { file: current, status },
    };
  }
  return {
    ...sessionsJson,
    [sessionKey]: { key: sessionKey, status },
  };
}

function removeSessionFromStorageIndex(
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
  const next = { ...sessionsJson };
  delete next[sessionKey];
  return next;
}

function buildDeletedTranscriptPath(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl')
    ? `${transcriptPath.slice(0, -'.jsonl'.length)}.deleted.jsonl`
    : `${transcriptPath}.deleted`;
}

export class SessionStorageRepository implements SessionStoragePort {
  // 按 agentId 缓存上次扫描得到的 descriptors。下次扫描时若 sessions.json 与 sessions 目录的
  // (size, mtimeMs) 都没变化，则直接复用 descriptors，跳过 readJsonRecordFromFileSystem +
  // listDirectory(sessionsDir) 的目录列举与 JSON 解析开销。
  private readonly agentDescriptorsCache = new Map<string, {
    readonly sessionsJsonFingerprint: { size: number; mtimeMs: number } | null;
    readonly sessionsDirFingerprint: { mtimeMs: number } | null;
    readonly descriptors: SessionStorageDescriptor[];
  }>();

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
    const presentAgentIds = new Set<string>();
    for (const agentDirEntry of agentEntries) {
      if (!agentDirEntry.isDirectory) {
        continue;
      }
      const agentId = agentDirEntry.name;
      presentAgentIds.add(agentId);
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');

      const sessionsJsonFingerprint = await this.statFingerprint(sessionsJsonPath);
      const sessionsDirFingerprint = await this.statDirFingerprint(sessionsDir);

      const cached = this.agentDescriptorsCache.get(agentId);
      if (
        cached
        && this.fingerprintEqual(cached.sessionsJsonFingerprint, sessionsJsonFingerprint)
        && this.fingerprintEqual(cached.sessionsDirFingerprint, sessionsDirFingerprint)
      ) {
        descriptors.push(...cached.descriptors);
        continue;
      }

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
      const transcriptDescriptors = listTranscriptStorageDescriptors({
        agentId,
        sessionsDir,
        sessionsJsonPath: sessionsJson ? sessionsJsonPath : null,
        sessionsJson,
        entryNames,
        indexedDescriptors,
      });

      const agentDescriptors: SessionStorageDescriptor[] = [
        ...indexedDescriptors,
        ...transcriptDescriptors,
      ];
      this.agentDescriptorsCache.set(agentId, {
        sessionsJsonFingerprint,
        sessionsDirFingerprint,
        descriptors: agentDescriptors,
      });
      descriptors.push(...agentDescriptors);
    }

    // agent 目录被删除时同步清掉缓存条目，避免长跑内存增长。
    for (const cachedAgentId of [...this.agentDescriptorsCache.keys()]) {
      if (!presentAgentIds.has(cachedAgentId)) {
        this.agentDescriptorsCache.delete(cachedAgentId);
      }
    }

    return descriptors;
  }

  private async statFingerprint(pathname: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const fileStat = await this.deps.fileSystem.stat(pathname);
      if (!fileStat.isFile) {
        return null;
      }
      return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    } catch {
      return null;
    }
  }

  private async statDirFingerprint(pathname: string): Promise<{ mtimeMs: number } | null> {
    try {
      const fileStat = await this.deps.fileSystem.stat(pathname);
      if (!fileStat.isDirectory) {
        return null;
      }
      return { mtimeMs: fileStat.mtimeMs };
    } catch {
      return null;
    }
  }

  private fingerprintEqual(
    left: { size?: number; mtimeMs: number } | null,
    right: { size?: number; mtimeMs: number } | null,
  ): boolean {
    if (left === null && right === null) {
      return true;
    }
    if (left === null || right === null) {
      return false;
    }
    return left.mtimeMs === right.mtimeMs && left.size === right.size;
  }

  private invalidateAgentDescriptorsCache(agentId: string): void {
    this.agentDescriptorsCache.delete(agentId);
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

  async updateSessionStatus(
    sessionKey: string,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<boolean> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    if (!descriptor?.sessionsJson || !descriptor.sessionsJsonPath) {
      return false;
    }
    await this.deps.fileSystem.writeTextFile(
      descriptor.sessionsJsonPath,
      JSON.stringify(updateStorageIndexStatus(descriptor.sessionsJson, sessionKey, status), null, 2),
    );
    this.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    if (!descriptor?.sessionsJson || !descriptor.sessionsJsonPath) {
      return false;
    }
    if (descriptor.transcriptPath && await this.deps.fileSystem.exists(descriptor.transcriptPath)) {
      await this.deps.fileSystem.rename(
        descriptor.transcriptPath,
        buildDeletedTranscriptPath(descriptor.transcriptPath),
      );
    }
    await this.deps.fileSystem.writeTextFile(
      descriptor.sessionsJsonPath,
      JSON.stringify(removeSessionFromStorageIndex(descriptor.sessionsJson, sessionKey), null, 2),
    );
    this.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

}
