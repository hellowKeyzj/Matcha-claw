import type {
  AuthProfileEntry,
  AuthProfilesStore,
  OAuthProfileEntry,
  OpenClawAuthStoreWorkflow,
} from '../workflows/openclaw-auth/openclaw-auth-store-workflow';
export {
  AUTH_PROFILE_FILENAME,
  AUTH_STORE_VERSION,
  readJsonFile,
  writeJsonFile,
  type AuthProfileEntry,
  type AuthProfilesStore,
  type OAuthProfileEntry,
} from '../workflows/openclaw-auth/openclaw-auth-store-workflow';

export class OpenClawAuthRepository {
  constructor(
    private readonly storeWorkflow: Pick<OpenClawAuthStoreWorkflow,
      | 'getAuthProfilesPath'
      | 'readAuthProfiles'
      | 'writeAuthProfiles'
      | 'discoverAgentIds'
      | 'readOpenClawJson'
    >,
  ) {}

  getAuthProfilesPath(agentId = 'main'): string {
    return this.storeWorkflow.getAuthProfilesPath(agentId);
  }

  async readAuthProfiles(agentId = 'main'): Promise<AuthProfilesStore> {
    return await this.storeWorkflow.readAuthProfiles(agentId);
  }

  async writeAuthProfiles(store: AuthProfilesStore, agentId = 'main'): Promise<void> {
    await this.storeWorkflow.writeAuthProfiles(store, agentId);
  }

  async discoverAgentIds(): Promise<string[]> {
    return await this.storeWorkflow.discoverAgentIds();
  }

  async readOpenClawJson(): Promise<Record<string, unknown>> {
    return await this.storeWorkflow.readOpenClawJson();
  }
}
