import type { RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
import type { SessionStorageIndexWorkflow } from './session-storage-index-workflow';
import type { SessionStorageMutationWorkflow } from './session-storage-mutation-workflow';
import type { SessionStorageTranscriptWorkflow } from './session-storage-transcript-workflow';
import type { SessionStorageDescriptor, SessionTranscriptFingerprint } from '../../sessions/session-storage-repository';

export interface SessionStorageRepositoryWorkflowDeps {
  readonly indexWorkflow: Pick<SessionStorageIndexWorkflow, 'listStorageDescriptors' | 'findStorageDescriptor' | 'invalidateAgentDescriptorsCache'>;
  readonly mutationWorkflow: Pick<SessionStorageMutationWorkflow, 'upsertRuntimeAddress' | 'updateStatus' | 'rename' | 'delete'>;
  readonly transcriptWorkflow: Pick<SessionStorageTranscriptWorkflow,
    | 'getTranscriptFingerprint'
    | 'readTranscriptDescriptorContent'
    | 'readTranscriptDescriptorLines'
  >;
}

export class SessionStorageRepositoryWorkflow {
  constructor(private readonly deps: SessionStorageRepositoryWorkflowDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    return await this.deps.indexWorkflow.listStorageDescriptors();
  }

  async findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null> {
    return await this.deps.indexWorkflow.findStorageDescriptor(sessionKey);
  }

  async getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null> {
    return await this.deps.transcriptWorkflow.getTranscriptFingerprint(pathname);
  }

  async readTranscriptContent(sessionKey: string): Promise<string | null> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    return descriptor ? await this.readTranscriptDescriptorContent(descriptor) : null;
  }

  async readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null> {
    return await this.deps.transcriptWorkflow.readTranscriptDescriptorContent(descriptor);
  }

  async *readTranscriptLines(sessionKey: string): AsyncIterable<string> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    if (!descriptor) {
      return;
    }
    yield* this.readTranscriptDescriptorLines(descriptor);
  }

  async *readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string> {
    yield* this.deps.transcriptWorkflow.readTranscriptDescriptorLines(descriptor);
  }

  async upsertSessionRuntimeAddress(sessionKey: string, runtimeAddress: RuntimeAddress): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(sessionKey);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.upsertRuntimeAddress(descriptor, sessionKey, runtimeAddress);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async updateSessionStatus(
    sessionKey: string,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(sessionKey);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.updateStatus(descriptor, sessionKey, status);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async renameSession(sessionKey: string, label: string): Promise<boolean> {
    const normalizedLabel = normalizeString(label);
    if (!normalizedLabel) {
      return false;
    }
    const descriptor = await this.findWritableDescriptor(sessionKey);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.rename(descriptor, sessionKey, normalizedLabel);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(sessionKey);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.delete(descriptor, sessionKey);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  private async findWritableDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null> {
    const descriptor = await this.findStorageDescriptor(sessionKey);
    return descriptor?.sessionsJson && descriptor.sessionsJsonPath ? descriptor : null;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
