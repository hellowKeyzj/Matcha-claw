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
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

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
  setTheme: (theme: Theme, runtimeAddress: RuntimeAddress) => Promise<void>;
  setLanguage: (language: string, runtimeAddress: RuntimeAddress) => Promise<void>;
  setUserAvatarDataUrl: (dataUrl: string | null, runtimeAddress: RuntimeAddress) => Promise<void>;
  clearUserAvatar: (runtimeAddress: RuntimeAddress) => Promise<void>;
  setStartMinimized: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  setLaunchAtStartup: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  setTelemetryEnabled: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  setGatewayAutoStart: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  setGatewayPort: (port: number, runtimeAddress: RuntimeAddress) => Promise<void>;
  setUpdateChannel: (channel: UpdateChannel, runtimeAddress: RuntimeAddress) => Promise<void>;
  setAutoCheckUpdate: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  setDevModeUnlocked: (value: boolean, runtimeAddress: RuntimeAddress) => Promise<void>;
  markSetupComplete: (runtimeAddress: RuntimeAddress) => Promise<void>;
  resetSettings: (runtimeAddress: RuntimeAddress) => Promise<void>;
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

      setTheme: async (theme, runtimeAddress) => {
        await hostSettingsPutValue('theme', theme, runtimeAddress);
        set({ theme });
      },
      setLanguage: async (language, runtimeAddress) => {
        const resolvedLanguage = resolveSupportedLanguage(language);
        await hostSettingsPutValue('language', resolvedLanguage, runtimeAddress);
        i18n.changeLanguage(resolvedLanguage);
        set({ language: resolvedLanguage });
      },
      setUserAvatarDataUrl: async (userAvatarDataUrl, runtimeAddress) => {
        await hostSettingsPutValue('userAvatarDataUrl', userAvatarDataUrl, runtimeAddress);
        set({ userAvatarDataUrl });
      },
      clearUserAvatar: async (runtimeAddress) => {
        await hostSettingsPutValue('userAvatarDataUrl', null, runtimeAddress);
        set({ userAvatarDataUrl: null });
      },
      setStartMinimized: async (startMinimized, runtimeAddress) => {
        await hostSettingsPutValue('startMinimized', startMinimized, runtimeAddress);
        set({ startMinimized });
      },
      setLaunchAtStartup: async (launchAtStartup, runtimeAddress) => {
        await hostSettingsPutValue('launchAtStartup', launchAtStartup, runtimeAddress);
        set({ launchAtStartup });
      },
      setTelemetryEnabled: async (telemetryEnabled, runtimeAddress) => {
        await hostSettingsPutValue('telemetryEnabled', telemetryEnabled, runtimeAddress);
        set({ telemetryEnabled });
      },
      setGatewayAutoStart: async (gatewayAutoStart, runtimeAddress) => {
        await hostSettingsPutValue('gatewayAutoStart', gatewayAutoStart, runtimeAddress);
        set({ gatewayAutoStart });
      },
      setGatewayPort: async (gatewayPort, runtimeAddress) => {
        await hostSettingsPutValue('gatewayPort', gatewayPort, runtimeAddress);
        set({ gatewayPort });
      },
      setUpdateChannel: async (updateChannel, runtimeAddress) => {
        await hostSettingsPutValue('updateChannel', updateChannel, runtimeAddress);
        set({ updateChannel });
      },
      setAutoCheckUpdate: async (autoCheckUpdate, runtimeAddress) => {
        await hostSettingsPutValue('autoCheckUpdate', autoCheckUpdate, runtimeAddress);
        set({ autoCheckUpdate });
      },
      setDevModeUnlocked: async (devModeUnlocked, runtimeAddress) => {
        await hostSettingsPutValue('devModeUnlocked', devModeUnlocked, runtimeAddress);
        set({ devModeUnlocked });
      },
      markSetupComplete: async (runtimeAddress) => {
        await hostSettingsPutValue('setupComplete', true, runtimeAddress);
        set({ setupComplete: true });
      },
      resetSettings: async (runtimeAddress) => {
        const settings = await hostSettingsReset<Partial<SettingsSnapshot>>(runtimeAddress);
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
