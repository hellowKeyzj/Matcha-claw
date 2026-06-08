import type { SessionIdentity } from '../agent-runtime/contracts/runtime-address';
import type { SessionStorageDescriptor } from './session-storage-repository';
import type { SessionModelResolutionWorkflow } from '../workflows/session-metadata/session-model-resolution-workflow';
export {
  readAgentModelValue,
  resolveAgentConfigDefaultModel,
} from '../workflows/session-metadata/session-model-resolution-workflow';

export interface SessionDefaultModelResolverPort {
  resolveDefaultModel(sessionIdentity: SessionIdentity): Promise<string | null>;
}

export interface SessionMetadataRepositoryDeps {
  modelResolutionWorkflow: Pick<SessionModelResolutionWorkflow, 'resolveSessionModel'>;
}

export interface SessionMetadataPort {
  resolveSessionModel(input: {
    sessionIdentity: SessionIdentity;
    storageDescriptor: SessionStorageDescriptor | null;
    runtimeModel?: string | null;
  }): Promise<string | null>;
}

export class SessionMetadataRepository implements SessionMetadataPort {
  constructor(private readonly deps: SessionMetadataRepositoryDeps) {}

  async resolveSessionModel(input: {
    sessionIdentity: SessionIdentity;
    storageDescriptor: SessionStorageDescriptor | null;
    runtimeModel?: string | null;
  }): Promise<string | null> {
    return await this.deps.modelResolutionWorkflow.resolveSessionModel(input);
  }
}
