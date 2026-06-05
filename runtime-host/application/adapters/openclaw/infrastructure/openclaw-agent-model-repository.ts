import type {
  OpenClawAgentModelProviderEntry,
  OpenClawAgentModelStoreWorkflow,
} from '../workflows/openclaw-auth/openclaw-agent-model-store-workflow';
export type {
  OpenClawAgentModelEntry,
  OpenClawAgentModelProviderEntry,
} from '../workflows/openclaw-auth/openclaw-agent-model-store-workflow';

export interface OpenClawAgentModelRepositoryPort {
  upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: OpenClawAgentModelProviderEntry;
  }): Promise<string[]>;
  removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]>;
}

export class OpenClawAgentModelRepository implements OpenClawAgentModelRepositoryPort {
  constructor(
    private readonly storeWorkflow: Pick<OpenClawAgentModelStoreWorkflow,
      | 'upsertProviderInAgentModels'
      | 'removeProviderFromAgentModels'
    >,
  ) {}

  async upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: OpenClawAgentModelProviderEntry;
  }): Promise<string[]> {
    return await this.storeWorkflow.upsertProviderInAgentModels(input);
  }

  async removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]> {
    return await this.storeWorkflow.removeProviderFromAgentModels(input);
  }
}
