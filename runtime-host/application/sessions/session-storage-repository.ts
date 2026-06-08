import type { SessionIdentity } from '../agent-runtime/contracts/runtime-address';
import type { SessionStorageRepositoryWorkflow } from '../workflows/session-storage/session-storage-repository-workflow';

export interface SessionStorageDescriptor {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  sessionStoreEntry: Record<string, unknown> | null;
  sessionIdentity: SessionIdentity;
  transcriptPath: string | null;
}

export interface SessionTranscriptFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SessionConfigDirectoryPort {
  getConfigDir(): string;
}

export interface SessionExternalArtefactResolverPort {
  resolveExternalArtefactPaths(input: {
    pointerPath: string;
    pointerContent: string;
    transcriptDir: string;
  }): readonly string[];
}

export interface SessionStorageRepositoryDeps {
  repositoryWorkflow: Pick<SessionStorageRepositoryWorkflow,
    | 'listStorageDescriptors'
    | 'findStorageDescriptor'
    | 'getTranscriptFingerprint'
    | 'readTranscriptContent'
    | 'readTranscriptDescriptorContent'
    | 'readTranscriptLines'
    | 'readTranscriptDescriptorLines'
    | 'upsertSessionIdentity'
    | 'updateSessionStatus'
    | 'renameSession'
    | 'deleteSession'
  >;
}

export interface SessionStoragePort {
  listStorageDescriptors(): Promise<SessionStorageDescriptor[]>;
  findStorageDescriptor(identity: SessionIdentity): Promise<SessionStorageDescriptor | null>;
  getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null>;
  readTranscriptContent(identity: SessionIdentity): Promise<string | null>;
  readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null>;
  readTranscriptLines(identity: SessionIdentity): AsyncIterable<string>;
  readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string>;
  deleteSession(identity: SessionIdentity): Promise<boolean>;
  renameSession(identity: SessionIdentity, label: string): Promise<boolean>;
  updateSessionStatus(identity: SessionIdentity, status: 'active' | 'completed' | 'archived' | 'deleted'): Promise<boolean>;
  upsertSessionIdentity(sessionIdentity: SessionIdentity): Promise<boolean>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readSessionStoreLabel(entry: Record<string, unknown> | null): string | null {
  const label = normalizeString(entry?.label);
  return label || null;
}

export class SessionStorageRepository implements SessionStoragePort {
  constructor(private readonly deps: SessionStorageRepositoryDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    return await this.deps.repositoryWorkflow.listStorageDescriptors();
  }

  async findStorageDescriptor(identity: SessionIdentity): Promise<SessionStorageDescriptor | null> {
    return await this.deps.repositoryWorkflow.findStorageDescriptor(identity);
  }

  async getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null> {
    return await this.deps.repositoryWorkflow.getTranscriptFingerprint(pathname);
  }

  async readTranscriptContent(identity: SessionIdentity): Promise<string | null> {
    return await this.deps.repositoryWorkflow.readTranscriptContent(identity);
  }

  async readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null> {
    return await this.deps.repositoryWorkflow.readTranscriptDescriptorContent(descriptor);
  }

  async *readTranscriptLines(identity: SessionIdentity): AsyncIterable<string> {
    yield* this.deps.repositoryWorkflow.readTranscriptLines(identity);
  }

  async *readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string> {
    yield* this.deps.repositoryWorkflow.readTranscriptDescriptorLines(descriptor);
  }

  async upsertSessionIdentity(sessionIdentity: SessionIdentity): Promise<boolean> {
    return await this.deps.repositoryWorkflow.upsertSessionIdentity(sessionIdentity);
  }

  async updateSessionStatus(
    identity: SessionIdentity,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<boolean> {
    return await this.deps.repositoryWorkflow.updateSessionStatus(identity, status);
  }

  async renameSession(identity: SessionIdentity, label: string): Promise<boolean> {
    return await this.deps.repositoryWorkflow.renameSession(identity, label);
  }

  async deleteSession(identity: SessionIdentity): Promise<boolean> {
    return await this.deps.repositoryWorkflow.deleteSession(identity);
  }
}
