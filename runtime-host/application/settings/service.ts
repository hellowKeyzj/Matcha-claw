interface SettingsServiceDeps {
  getAllSettings: () => Promise<Record<string, unknown>>;
  setSettingsPatch: (patch: Record<string, unknown>) => Promise<unknown>;
  resetSettings: () => Promise<Record<string, unknown>>;
  setSettingValue: (key: string, value: unknown) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  async getAll() {
    return await this.deps.getAllSettings();
  }

  async patch(payload: unknown) {
    const patch = isRecord(payload) ? payload : {};
    await this.deps.setSettingsPatch(patch);
    return { success: true };
  }

  async reset() {
    const settings = await this.deps.resetSettings();
    return { success: true, settings };
  }

  async getValue(key: string) {
    const settings = await this.deps.getAllSettings();
    return { value: settings[key] };
  }

  async setValue(key: string, payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    await this.deps.setSettingValue(key, body.value);
    return { success: true };
  }
}
