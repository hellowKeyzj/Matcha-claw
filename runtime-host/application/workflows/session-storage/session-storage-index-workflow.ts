import { isAbsolute, join, win32 } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import { buildSessionIdentityKey, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type {
  SessionConfigDirectoryPort,
  SessionStorageDescriptor,
} from '../../sessions/session-storage-repository';

interface AgentDescriptorsCacheEntry {
  readonly sessionsJsonFingerprint: { size: number; mtimeMs: number } | null;
  readonly sessionsDirFingerprint: { mtimeMs: number } | null;
  readonly descriptors: SessionStorageDescriptor[];
}

export interface SessionStorageSessionIdentityResolverPort {
  resolveStorageSessionIdentity(input: {
    agentId: string;
    sessionKey: string;
    sessionStoreEntry: Record<string, unknown> | null;
  }): SessionIdentity | null;
}

export interface SessionStorageIndexWorkflowDeps {
  readonly workspace: SessionConfigDirectoryPort;
  readonly fileSystem: RuntimeFileSystemPort;
  readonly sessionIdentityResolver: SessionStorageSessionIdentityResolverPort;
}

export class SessionStorageIndexWorkflow {
  private readonly agentDescriptorsCache = new Map<string, AgentDescriptorsCacheEntry>();
  private readonly sessionDescriptorIndex = new Map<string, SessionStorageDescriptor>();

  constructor(private readonly deps: SessionStorageIndexWorkflowDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    const agentsDir = join(this.deps.workspace.getConfigDir(), 'agents');
    let agentEntries: Array<{ isDirectory: boolean; name: string }>;
    try {
      agentEntries = await this.deps.fileSystem.listDirectory(agentsDir);
    } catch {
      this.sessionDescriptorIndex.clear();
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
      descriptors.push(...await this.listAgentDescriptors(agentsDir, agentId));
    }

    this.pruneMissingAgentCacheEntries(presentAgentIds);
    this.rebuildSessionDescriptorIndex(descriptors);
    return descriptors;
  }

  async findStorageDescriptor(identity: SessionIdentity): Promise<SessionStorageDescriptor | null> {
    const sessionIdentityKey = buildSessionIdentityKey(identity);
    const cached = this.sessionDescriptorIndex.get(sessionIdentityKey);
    if (cached) {
      return cached;
    }
    await this.listStorageDescriptors();
    return this.sessionDescriptorIndex.get(sessionIdentityKey) ?? null;
  }

  invalidateAgentDescriptorsCache(agentId: string): void {
    this.agentDescriptorsCache.delete(agentId);
    this.sessionDescriptorIndex.clear();
  }

  private async listAgentDescriptors(agentsDir: string, agentId: string): Promise<SessionStorageDescriptor[]> {
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    const sessionsJsonFingerprint = await this.statFingerprint(sessionsJsonPath);
    const sessionsDirFingerprint = await this.statDirFingerprint(sessionsDir);

    const cached = this.agentDescriptorsCache.get(agentId);
    if (
      cached
      && fingerprintEqual(cached.sessionsJsonFingerprint, sessionsJsonFingerprint)
      && fingerprintEqual(cached.sessionsDirFingerprint, sessionsDirFingerprint)
    ) {
      return cached.descriptors;
    }

    const sessionsJson = await readJsonRecordFromFileSystem(this.deps.fileSystem, sessionsJsonPath);
    const indexedDescriptors = sessionsJson ? listAgentStorageDescriptors({
      agentId,
      sessionsDir,
      sessionsJsonPath,
      sessionsJson,
      sessionIdentityResolver: this.deps.sessionIdentityResolver,
    }) : [];
    const transcriptDescriptors = listTranscriptStorageDescriptors({
      agentId,
      sessionsDir,
      sessionsJsonPath: sessionsJson ? sessionsJsonPath : null,
      sessionsJson,
      entryNames: await this.listSessionEntryNames(sessionsDir),
      indexedDescriptors,
      sessionIdentityResolver: this.deps.sessionIdentityResolver,
    });
    const descriptors = [
      ...indexedDescriptors,
      ...transcriptDescriptors,
    ];

    this.agentDescriptorsCache.set(agentId, {
      sessionsJsonFingerprint,
      sessionsDirFingerprint,
      descriptors,
    });
    return descriptors;
  }

  private async listSessionEntryNames(sessionsDir: string): Promise<string[]> {
    try {
      return (await this.deps.fileSystem.listDirectory(sessionsDir))
        .filter((entry) => entry.isFile)
        .map((entry) => entry.name);
    } catch {
      return [];
    }
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

  private pruneMissingAgentCacheEntries(presentAgentIds: ReadonlySet<string>): void {
    for (const cachedAgentId of [...this.agentDescriptorsCache.keys()]) {
      if (!presentAgentIds.has(cachedAgentId)) {
        this.agentDescriptorsCache.delete(cachedAgentId);
      }
    }
  }

  private rebuildSessionDescriptorIndex(descriptors: ReadonlyArray<SessionStorageDescriptor>): void {
    this.sessionDescriptorIndex.clear();
    for (const descriptor of descriptors) {
      this.sessionDescriptorIndex.set(buildSessionIdentityKey(descriptor.sessionIdentity), descriptor);
    }
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

function createStorageDescriptor(
  resolver: SessionStorageSessionIdentityResolverPort,
  input: Omit<SessionStorageDescriptor, 'sessionIdentity'>,
): SessionStorageDescriptor | null {
  const sessionIdentity = resolver.resolveStorageSessionIdentity({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionStoreEntry: input.sessionStoreEntry,
  });
  return sessionIdentity ? { ...input, sessionIdentity } : null;
}

function listAgentStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string;
  sessionsJson: Record<string, unknown>;
  sessionIdentityResolver: SessionStorageSessionIdentityResolverPort;
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
      const descriptor = createStorageDescriptor(input.sessionIdentityResolver, {
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        sessionStoreEntry: candidate,
        transcriptPath: resolveIndexedTranscriptPath(candidate, input.sessionsDir),
      });
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  }

  for (const [sessionKey, value] of Object.entries(input.sessionsJson)) {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalizedFileName = value.endsWith('.jsonl') ? value : `${value}.jsonl`;
      const descriptor = createStorageDescriptor(input.sessionIdentityResolver, {
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        sessionStoreEntry: null,
        transcriptPath: join(input.sessionsDir, normalizedFileName),
      });
      if (descriptor) {
        descriptors.push(descriptor);
      }
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const descriptor = createStorageDescriptor(input.sessionIdentityResolver, {
      sessionKey,
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      sessionStoreEntry: value,
      transcriptPath: resolveIndexedTranscriptPath(value, input.sessionsDir),
    });
    if (descriptor) {
      descriptors.push(descriptor);
    }
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

function buildFallbackSessionKey(agentId: string, transcriptFileName: string): string | null {
  const suffix = transcriptFileName.slice(0, -'.jsonl'.length);
  if (isTeamRoleLocalSessionKey(suffix)) {
    return null;
  }
  return `agent:${agentId}:${suffix}`;
}

function isTeamRoleLocalSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('team-role-session-');
}

function listTranscriptStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  entryNames: readonly string[];
  indexedDescriptors?: readonly SessionStorageDescriptor[];
  sessionIdentityResolver: SessionStorageSessionIdentityResolverPort;
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
    const fallbackSessionKey = buildFallbackSessionKey(input.agentId, transcriptFileName);
    if (!fallbackSessionKey) {
      continue;
    }
    const descriptor = createStorageDescriptor(input.sessionIdentityResolver, {
      sessionKey: fallbackSessionKey,
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      sessionStoreEntry: null,
      transcriptPath,
    });
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }

  return descriptors;
}

function fingerprintEqual(
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
