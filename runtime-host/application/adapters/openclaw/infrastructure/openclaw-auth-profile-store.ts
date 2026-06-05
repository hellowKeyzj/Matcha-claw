import type { OpenClawAuthProfileWorkflow } from '../workflows/openclaw-auth/openclaw-auth-profile-workflow';

export {
  removeProfileFromStore,
  removeProfilesForProvider,
} from '../workflows/openclaw-auth/openclaw-auth-profile-workflow';

export class OpenClawAuthProfileService {
  constructor(
    private readonly profileWorkflow: Pick<OpenClawAuthProfileWorkflow,
      | 'saveOAuthToken'
      | 'getOAuthToken'
      | 'getProviderApiKey'
      | 'saveProviderKey'
      | 'removeProviderKey'
    >,
  ) {}

  async saveOAuthToken(
    provider: string,
    token: { access: string; refresh: string; expires: number; email?: string; projectId?: string },
    agentId?: string,
  ): Promise<void> {
    await this.profileWorkflow.saveOAuthToken(provider, token, agentId);
  }

  async getOAuthToken(
    provider: string,
    agentId = 'main',
  ): Promise<string | null> {
    return await this.profileWorkflow.getOAuthToken(provider, agentId);
  }

  async getProviderApiKey(
    provider: string,
    agentId?: string,
  ): Promise<string | null> {
    return await this.profileWorkflow.getProviderApiKey(provider, agentId);
  }

  async saveProviderKey(
    provider: string,
    apiKey: string,
    agentId?: string,
  ): Promise<void> {
    await this.profileWorkflow.saveProviderKey(provider, apiKey, agentId);
  }

  async removeProviderKey(
    provider: string,
    agentId?: string,
  ): Promise<void> {
    await this.profileWorkflow.removeProviderKey(provider, agentId);
  }
}
