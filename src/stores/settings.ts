/**
 * Settings State Store
 * Manages application settings
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '@/i18n';
import { resolveSupportedLanguage } from '@/i18n/language';
import {
  hostSettingsFetchAll,
  hostSettingsPutPatch,
} from '@/lib/settings-runtime';

type Theme = 'light' | 'dark' | 'system';
type UpdateChannel = 'stable' | 'beta' | 'dev';
type BrowserMode = 'off' | 'relay' | 'native';

interface SettingsState {
  // General
  theme: Theme;
  language: string;
  userAvatarDataUrl: string | null;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  browserMode: BrowserMode;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;

  // Update
  updateChannel: UpdateChannel;
  autoCheckUpdate: boolean;

  // UI State
  devModeUnlocked: boolean;

  initialized: boolean;

  // Actions
  init: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setLanguage: (language: string) => Promise<void>;
  setUserAvatarDataUrl: (dataUrl: string | null) => Promise<void>;
  clearUserAvatar: () => Promise<void>;
  setStartMinimized: (value: boolean) => Promise<void>;
  setLaunchAtStartup: (value: boolean) => Promise<void>;
  setTelemetryEnabled: (value: boolean) => Promise<void>;
  setGatewayAutoStart: (value: boolean) => Promise<void>;
  setGatewayPort: (port: number) => Promise<void>;
  setUpdateChannel: (channel: UpdateChannel) => Promise<void>;
  setAutoCheckUpdate: (value: boolean) => Promise<void>;
  setDevModeUnlocked: (value: boolean) => Promise<void>;
  saveRuntimeSettings: (patch: Partial<RuntimeSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

const defaultSettings = {
  theme: 'system' as Theme,
  language: resolveSupportedLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined),
  userAvatarDataUrl: null,
  startMinimized: false,
  launchAtStartup: false,
  telemetryEnabled: true,
  gatewayAutoStart: true,
  gatewayPort: 18789,
  browserMode: 'relay' as BrowserMode,
  proxyEnabled: false,
  proxyServer: '',
  proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
  updateChannel: 'stable' as UpdateChannel,
  autoCheckUpdate: true,
  devModeUnlocked: false,
  initialized: false,
};

type SettingsSnapshot = typeof defaultSettings;
type RuntimeSettings = Pick<SettingsSnapshot,
  'browserMode' | 'launchAtStartup' | 'gatewayAutoStart' | 'proxyEnabled' | 'proxyServer' | 'proxyBypassRules'
>;
const runtimeSettingRevisions: Record<keyof RuntimeSettings, number> = {
  browserMode: 0,
  launchAtStartup: 0,
  gatewayAutoStart: 0,
  proxyEnabled: 0,
  proxyServer: 0,
  proxyBypassRules: 0,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,

      init: async () => {
        const requestRevisions = { ...runtimeSettingRevisions };
        try {
          const runtimeSettings = await hostSettingsFetchAll<RuntimeSettings>();
          set({
            ...Object.fromEntries((Object.keys(requestRevisions) as Array<keyof RuntimeSettings>)
              .filter((key) => requestRevisions[key] === runtimeSettingRevisions[key])
              .map((key) => [key, runtimeSettings[key]])),
            initialized: true,
          });
        } catch {
          // Keep renderer-persisted settings as a fallback when the main
          // process store is not reachable.
          set({ initialized: true });
        }
      },

      setTheme: async (theme) => {
        set({ theme });
      },
      setLanguage: async (language) => {
        const resolvedLanguage = resolveSupportedLanguage(language);
        i18n.changeLanguage(resolvedLanguage);
        set({ language: resolvedLanguage });
      },
      setUserAvatarDataUrl: async (userAvatarDataUrl) => {
        set({ userAvatarDataUrl });
      },
      clearUserAvatar: async () => {
        set({ userAvatarDataUrl: null });
      },
      setStartMinimized: async (startMinimized) => {
        set({ startMinimized });
      },
      setLaunchAtStartup: async (launchAtStartup) => {
        await get().saveRuntimeSettings({ launchAtStartup });
      },
      setTelemetryEnabled: async (telemetryEnabled) => {
        set({ telemetryEnabled });
      },
      setGatewayAutoStart: async (gatewayAutoStart) => {
        await get().saveRuntimeSettings({ gatewayAutoStart });
      },
      setGatewayPort: async (gatewayPort) => {
        set({ gatewayPort });
      },
      setUpdateChannel: async (updateChannel) => {
        set({ updateChannel });
      },
      setAutoCheckUpdate: async (autoCheckUpdate) => {
        set({ autoCheckUpdate });
      },
      setDevModeUnlocked: async (devModeUnlocked) => {
        set({ devModeUnlocked });
      },
      saveRuntimeSettings: async (patch) => {
        await hostSettingsPutPatch(patch);
        for (const key of Object.keys(patch) as Array<keyof RuntimeSettings>) {
          runtimeSettingRevisions[key] += 1;
        }
        set(patch);
      },
      resetSettings: async () => {
        await get().saveRuntimeSettings({
          browserMode: defaultSettings.browserMode,
          launchAtStartup: defaultSettings.launchAtStartup,
          gatewayAutoStart: defaultSettings.gatewayAutoStart,
          proxyEnabled: defaultSettings.proxyEnabled,
          proxyServer: defaultSettings.proxyServer,
          proxyBypassRules: defaultSettings.proxyBypassRules,
        });
        i18n.changeLanguage(defaultSettings.language);
        set({ ...defaultSettings, initialized: true });
      },
    }),
    {
      name: 'matchaclaw-settings',
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<SettingsState>),
        initialized: false,
      }),
    }
  )
);
