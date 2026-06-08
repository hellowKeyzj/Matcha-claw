import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { SessionStorageIndexWorkflow } from './session-storage-index-workflow';
import type { SessionStorageMutationWorkflow } from './session-storage-mutation-workflow';
import type { SessionStorageTranscriptWorkflow } from './session-storage-transcript-workflow';
import type { SessionStorageDescriptor, SessionTranscriptFingerprint } from '../../sessions/session-storage-repository';

export interface SessionStorageRepositoryWorkflowDeps {
  readonly indexWorkflow: Pick<SessionStorageIndexWorkflow, 'listStorageDescriptors' | 'findStorageDescriptor' | 'invalidateAgentDescriptorsCache'>;
  readonly mutationWorkflow: Pick<SessionStorageMutationWorkflow, 'upsertSessionIdentity' | 'updateStatus' | 'rename' | 'delete'>;
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

  async findStorageDescriptor(identity: SessionIdentity): Promise<SessionStorageDescriptor | null> {
    return await this.deps.indexWorkflow.findStorageDescriptor(identity);
  }

  async getTranscriptFingerprint(pathname: string): Promise<SessionTranscriptFingerprint | null> {
    return await this.deps.transcriptWorkflow.getTranscriptFingerprint(pathname);
  }

  async readTranscriptContent(identity: SessionIdentity): Promise<string | null> {
    const descriptor = await this.findStorageDescriptor(identity);
    return descriptor ? await this.readTranscriptDescriptorContent(descriptor) : null;
  }

  async readTranscriptDescriptorContent(descriptor: SessionStorageDescriptor): Promise<string | null> {
    return await this.deps.transcriptWorkflow.readTranscriptDescriptorContent(descriptor);
  }

  async *readTranscriptLines(identity: SessionIdentity): AsyncIterable<string> {
    const descriptor = await this.findStorageDescriptor(identity);
    if (!descriptor) {
      return;
    }
    yield* this.readTranscriptDescriptorLines(descriptor);
  }

  async *readTranscriptDescriptorLines(descriptor: SessionStorageDescriptor): AsyncIterable<string> {
    yield* this.deps.transcriptWorkflow.readTranscriptDescriptorLines(descriptor);
  }

  async upsertSessionIdentity(sessionIdentity: SessionIdentity): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(sessionIdentity);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.upsertSessionIdentity(descriptor, sessionIdentity.sessionKey, sessionIdentity);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async updateSessionStatus(
    identity: SessionIdentity,
    status: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(identity);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.updateStatus(descriptor, identity.sessionKey, status);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async renameSession(identity: SessionIdentity, label: string): Promise<boolean> {
    const normalizedLabel = normalizeString(label);
    if (!normalizedLabel) {
      return false;
    }
    const descriptor = await this.findWritableDescriptor(identity);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.rename(descriptor, identity.sessionKey, normalizedLabel);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  async deleteSession(identity: SessionIdentity): Promise<boolean> {
    const descriptor = await this.findWritableDescriptor(identity);
    if (!descriptor) {
      return false;
    }
    await this.deps.mutationWorkflow.delete(descriptor, identity.sessionKey);
    this.deps.indexWorkflow.invalidateAgentDescriptorsCache(descriptor.agentId);
    return true;
  }

  private async findWritableDescriptor(identity: SessionIdentity): Promise<SessionStorageDescriptor | null> {
    const descriptor = await this.findStorageDescriptor(identity);
    return descriptor?.sessionsJson && descriptor.sessionsJsonPath ? descriptor : null;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
