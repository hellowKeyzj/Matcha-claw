import type { RuntimeAddress } from '../agent-runtime/contracts/runtime-address';
import type { SessionStorageRepositoryWorkflow } from '../workflows/session-storage/session-storage-repository-workflow';

export interface SessionStorageDescriptor {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  sessionStoreEntry: Record<string, unknown> | null;
  runtimeAddress: RuntimeAddress;
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
    | 'upsertSessionRuntimeAddress'
    | 'updateSessionStatus'
    | 'renameSession'
    | 'deleteSession'
  >;
}

export interface SessionStoragePort {
  listStorageDescriptors(): Promise<SessionStorageDescriptor[]>;
  findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null>;
  getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null>;
  readTranscriptContent(sessionKey: string): Promise<string | null>;
  readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null>;
  readTranscriptLines(sessionKey: string): AsyncIterable<string>;
  readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string>;
  deleteSession(sessionKey: string): Promise<boolean>;
  renameSession(sessionKey: string, label: string): Promise<boolean>;
  updateSessionStatus(sessionKey: string, status: 'active' | 'completed' | 'archived' | 'deleted'): Promise<boolean>;
  upsertSessionRuntimeAddress(sessionKey: string, runtimeAddress: RuntimeAddress): Promise<boolean>;
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

  async findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null> {
    return await this.deps.repositoryWorkflow.findStorageDescriptor(sessionKey);
  }

  async getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null> {
    return await this.deps.repositoryWorkflow.getTranscriptFingerprint(pathname);
  }

  async readTranscriptContent(sessionKey: string): Promise<string | null> {
    return await this.deps.repositoryWorkflow.readTranscriptContent(sessionKey);
  }

  async readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null> {
    return await this.deps.repositoryWorkflow.readTranscriptDescriptorContent(descriptor);
  }

  async *readTranscriptLines(sessionKey: string): AsyncIterable<string> {
    yield* this.deps.repositoryWorkflow.readTranscriptLines(sessionKey);
  }

  async *readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string> {
    yield* this.deps.repositoryWorkflow.readTranscriptDescriptorLines(descriptor);
  }

  async upsertSessionRuntimeAddress(sessionKey: string, runtimeAddress: RuntimeAddress): Promise<boolean> {
    return await this.deps.repositoryWorkflow.upsertSessionRuntimeAddress(sessionKey, runtimeAddress);
  }

  async updateSessionStatus(
    sessionKey: string,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<boolean> {
    return await this.deps.repositoryWorkflow.updateSessionStatus(sessionKey, status);
  }

  async renameSession(sessionKey: string, label: string): Promise<boolean> {
    return await this.deps.repositoryWorkflow.renameSession(sessionKey, label);
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    return await this.deps.repositoryWorkflow.deleteSession(sessionKey);
  }
}
