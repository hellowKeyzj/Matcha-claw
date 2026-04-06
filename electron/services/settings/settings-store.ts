/**
 * Persistent Storage
 * Electron-store wrapper for application settings
 */

import { randomBytes } from 'crypto';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsStoreInstance: any = null;

/**
 * Generate a random token for gateway authentication
 */
function generateToken(): string {
  return `clawx-${randomBytes(16).toString('hex')}`;
}

/**
 * Application settings schema
 */
export interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';
  language: string;
  userAvatarDataUrl: string | null;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;
  
  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
  clawHubToken: string;
  
  // Update
  updateChannel: 'stable' | 'beta' | 'dev';
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
  skippedVersions: string[];
  
  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;
  setupComplete: boolean;
  
  // Presets
  selectedBundles: string[];
  enabledSkills: string[];
  disabledSkills: string[];

  // Plugin Center
  pluginExecutionEnabled: boolean;
  pluginEnabledIds: string[];

  // Security
  securityPreset: 'strict' | 'balanced' | 'relaxed';
  securityPolicyVersion: number;
  securityPolicyByAgent: Record<string, {
    preset?: 'strict' | 'balanced' | 'relaxed';
    defaultAction?: 'allow' | 'confirm' | 'deny';
    allowTools?: string[];
    confirmTools?: string[];
    denyTools?: string[];
    allowPathPrefixes?: string[];
    allowDomains?: string[];
    allowCommandExecution?: boolean;
    allowDependencyInstall?: boolean;
    confirmStrategy?: 'every_time' | 'session';
    capabilities?: string[];
  }>;
}

/**
 * Default settings
 */
const defaults: AppSettings = {
  // General
  theme: 'system',
  language: 'en',
  userAvatarDataUrl: null,
  startMinimized: false,
  launchAtStartup: false,
  telemetryEnabled: true,
  
  // Gateway
  gatewayAutoStart: true,
  gatewayPort: 18789,
  gatewayToken: generateToken(),
  proxyEnabled: false,
  proxyServer: '',
  proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
  clawHubToken: '',
  
  // Update
  updateChannel: 'stable',
  autoCheckUpdate: true,
  autoDownloadUpdate: false,
  skippedVersions: [],
  
  // UI State
  sidebarCollapsed: false,
  devModeUnlocked: false,
  setupComplete: false,
  
  // Presets
  selectedBundles: ['productivity', 'developer'],
  enabledSkills: [],
  disabledSkills: [],

  // Plugin Center
  pluginExecutionEnabled: true,
  pluginEnabledIds: [],

  // Security
  securityPreset: 'balanced',
  securityPolicyVersion: 1,
  securityPolicyByAgent: {},
};

/**
 * Get the settings store instance (lazy initialization)
 */
async function getSettingsStore() {
  if (!settingsStoreInstance) {
    const Store = (await import('electron-store')).default;
    settingsStoreInstance = new Store<AppSettings>({
      name: 'settings',
      defaults,
    });
  }
  return settingsStoreInstance;
}

/**
 * Get a setting value
 */
export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const store = await getSettingsStore();
  return store.get(key);
}

/**
 * Set a setting value
 */
export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): Promise<void> {
  const store = await getSettingsStore();
  store.set(key, value);
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();
  return store.store;
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(): Promise<void> {
  const store = await getSettingsStore();
  store.clear();
}

/**
 * Export settings to JSON
 */
export async function exportSettings(): Promise<string> {
  const store = await getSettingsStore();
  return JSON.stringify(store.store, null, 2);
}

/**
 * Import settings from JSON
 */
export async function importSettings(json: string): Promise<void> {
  try {
    const settings = JSON.parse(json);
    const store = await getSettingsStore();
    store.set(settings);
  } catch {
    throw new Error('Invalid settings JSON');
  }
}
