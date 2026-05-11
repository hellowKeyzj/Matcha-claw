import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';

export interface OpenClawAgentModelRepositoryPort {
  removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]>;
}

export class OpenClawAgentModelRepository implements OpenClawAgentModelRepositoryPort {
  constructor(
    private readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir'>,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]> {
    const touchedAgentIds: string[] = [];
    for (const agentId of input.agentIds) {
      const modelsPath = join(this.configRepository.getConfigDir(), 'agents', agentId, 'agent', 'models.json');
      if (!(await this.fileSystem.exists(modelsPath))) {
        continue;
      }
      const raw = await this.fileSystem.readTextFile(modelsPath);
      const data = JSON.parse(raw) as Record<string, unknown>;
      const providers = data.providers as Record<string, unknown> | undefined;
      if (!providers || !providers[input.provider]) {
        continue;
      }
      delete providers[input.provider];
      await this.fileSystem.writeTextFile(modelsPath, JSON.stringify(data, null, 2));
      touchedAgentIds.push(agentId);
    }
    return touchedAgentIds;
  }
}
