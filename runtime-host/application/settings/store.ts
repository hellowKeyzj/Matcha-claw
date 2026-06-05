import type { SettingsStoreEnvironmentPort, SettingsStoreWorkflow } from '../workflows/settings-store/settings-store-workflow';

export type { SettingsStoreEnvironmentPort };

export class SettingsRepository {
  constructor(
    private readonly settingsWorkflow: Pick<SettingsStoreWorkflow, 'getAll' | 'patch' | 'setValue' | 'reset'>,
  ) {}

  async getAll() {
    return await this.settingsWorkflow.getAll();
  }

  async patch(patch: unknown) {
    return await this.settingsWorkflow.patch(patch);
  }

  async setValue(key: string, value: unknown) {
    return await this.settingsWorkflow.setValue(key, value);
  }

  async reset() {
    return await this.settingsWorkflow.reset();
  }
}
