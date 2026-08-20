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

  // Setup
  setupComplete: boolean;
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
  markSetupComplete: () => Promise<void>;
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
  setupComplete: false,
  initialized: false,
};

type SettingsSnapshot = typeof defaultSettings;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,

      init: async () => {
        try {
          const runtimeSettings = await hostSettingsFetchAll<Pick<
            SettingsSnapshot,
            'browserMode' | 'launchAtStartup' | 'gatewayAutoStart' | 'proxyEnabled' | 'proxyServer' | 'proxyBypassRules'
          >>();
          set((state) => ({
            ...state,
            browserMode: runtimeSettings.browserMode,
            launchAtStartup: runtimeSettings.launchAtStartup,
            gatewayAutoStart: runtimeSettings.gatewayAutoStart,
            proxyEnabled: runtimeSettings.proxyEnabled,
            proxyServer: runtimeSettings.proxyServer,
            proxyBypassRules: runtimeSettings.proxyBypassRules,
            initialized: true,
          }));
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
        await hostSettingsPutPatch({ launchAtStartup });
        set({ launchAtStartup });
      },
      setTelemetryEnabled: async (telemetryEnabled) => {
        set({ telemetryEnabled });
      },
      setGatewayAutoStart: async (gatewayAutoStart) => {
        await hostSettingsPutPatch({ gatewayAutoStart });
        set({ gatewayAutoStart });
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
      markSetupComplete: async () => {
        set({ setupComplete: true });
      },
      resetSettings: async () => {
        await hostSettingsPutPatch({
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
