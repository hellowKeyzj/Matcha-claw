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
  hostSettingsPutValue,
  hostSettingsReset,
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
          const settings = await hostSettingsFetchAll<Partial<SettingsSnapshot>>();
          const resolvedLanguage = settings.language
            ? resolveSupportedLanguage(settings.language)
            : undefined;
          set((state) => {
            const mergedSetupComplete = Boolean(state.setupComplete || settings.setupComplete);
            return {
              ...state,
              ...settings,
              ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
              setupComplete: mergedSetupComplete,
              initialized: true,
            };
          });
          if (resolvedLanguage) {
            i18n.changeLanguage(resolvedLanguage);
          }
        } catch {
          // Keep renderer-persisted settings as a fallback when the main
          // process store is not reachable.
          set({ initialized: true });
        }
      },

      setTheme: async (theme) => {
        set({ theme });
        await hostSettingsPutValue('theme', theme);
      },
      setLanguage: async (language) => {
        const resolvedLanguage = resolveSupportedLanguage(language);
        await hostSettingsPutValue('language', resolvedLanguage);
        i18n.changeLanguage(resolvedLanguage);
        set({ language: resolvedLanguage });
      },
      setUserAvatarDataUrl: async (userAvatarDataUrl) => {
        await hostSettingsPutValue('userAvatarDataUrl', userAvatarDataUrl);
        set({ userAvatarDataUrl });
      },
      clearUserAvatar: async () => {
        await hostSettingsPutValue('userAvatarDataUrl', null);
        set({ userAvatarDataUrl: null });
      },
      setStartMinimized: async (startMinimized) => {
        await hostSettingsPutValue('startMinimized', startMinimized);
        set({ startMinimized });
      },
      setLaunchAtStartup: async (launchAtStartup) => {
        await hostSettingsPutValue('launchAtStartup', launchAtStartup);
        set({ launchAtStartup });
      },
      setTelemetryEnabled: async (telemetryEnabled) => {
        await hostSettingsPutValue('telemetryEnabled', telemetryEnabled);
        set({ telemetryEnabled });
      },
      setGatewayAutoStart: async (gatewayAutoStart) => {
        await hostSettingsPutValue('gatewayAutoStart', gatewayAutoStart);
        set({ gatewayAutoStart });
      },
      setGatewayPort: async (gatewayPort) => {
        await hostSettingsPutValue('gatewayPort', gatewayPort);
        set({ gatewayPort });
      },
      setUpdateChannel: async (updateChannel) => {
        await hostSettingsPutValue('updateChannel', updateChannel);
        set({ updateChannel });
      },
      setAutoCheckUpdate: async (autoCheckUpdate) => {
        await hostSettingsPutValue('autoCheckUpdate', autoCheckUpdate);
        set({ autoCheckUpdate });
      },
      setDevModeUnlocked: async (devModeUnlocked) => {
        await hostSettingsPutValue('devModeUnlocked', devModeUnlocked);
        set({ devModeUnlocked });
      },
      markSetupComplete: async () => {
        await hostSettingsPutValue('setupComplete', true);
        set({ setupComplete: true });
      },
      resetSettings: async () => {
        const settings = await hostSettingsReset<Partial<SettingsSnapshot>>();
        const resolvedLanguage = settings.language
          ? resolveSupportedLanguage(settings.language)
          : undefined;
        if (resolvedLanguage) {
          i18n.changeLanguage(resolvedLanguage);
        }
        set({
          ...defaultSettings,
          ...settings,
          ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
          initialized: true,
        });
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
