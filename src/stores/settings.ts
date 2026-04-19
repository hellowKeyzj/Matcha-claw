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
  autoDownloadUpdate: boolean;

  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;

  // Setup
  setupComplete: boolean;
  initialized: boolean;

  // Actions
  init: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: string) => void;
  setUserAvatarDataUrl: (dataUrl: string | null) => void;
  clearUserAvatar: () => void;
  setStartMinimized: (value: boolean) => void;
  setLaunchAtStartup: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setGatewayAutoStart: (value: boolean) => void;
  setGatewayPort: (port: number) => void;
  setProxyEnabled: (value: boolean) => void;
  setProxyServer: (value: string) => void;
  setProxyBypassRules: (value: string) => void;
  setUpdateChannel: (channel: UpdateChannel) => void;
  setAutoCheckUpdate: (value: boolean) => void;
  setAutoDownloadUpdate: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setDevModeUnlocked: (value: boolean) => void;
  markSetupComplete: () => void;
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
  autoDownloadUpdate: false,
  sidebarCollapsed: false,
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
          let shouldSyncSetupComplete = false;
          set((state) => {
            const mergedSetupComplete = Boolean(state.setupComplete || settings.setupComplete);
            shouldSyncSetupComplete = mergedSetupComplete && !settings.setupComplete;
            return {
              ...state,
              ...settings,
              ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
              setupComplete: mergedSetupComplete,
              initialized: true,
            };
          });
          if (shouldSyncSetupComplete) {
            void hostSettingsPutValue('setupComplete', true).catch(() => {});
          }
          if (resolvedLanguage) {
            i18n.changeLanguage(resolvedLanguage);
          }
        } catch {
          // Keep renderer-persisted settings as a fallback when the main
          // process store is not reachable.
          set({ initialized: true });
        }
      },

      setTheme: (theme) => {
        set({ theme });
        void hostSettingsPutValue('theme', theme).catch(() => {});
      },
      setLanguage: (language) => {
        const resolvedLanguage = resolveSupportedLanguage(language);
        i18n.changeLanguage(resolvedLanguage);
        set({ language: resolvedLanguage });
        void hostSettingsPutValue('language', resolvedLanguage).catch(() => {});
      },
      setUserAvatarDataUrl: (userAvatarDataUrl) => {
        set({ userAvatarDataUrl });
        void hostSettingsPutValue('userAvatarDataUrl', userAvatarDataUrl).catch(() => {});
      },
      clearUserAvatar: () => {
        set({ userAvatarDataUrl: null });
        void hostSettingsPutValue('userAvatarDataUrl', null).catch(() => {});
      },
      setStartMinimized: (startMinimized) => {
        set({ startMinimized });
        void hostSettingsPutValue('startMinimized', startMinimized).catch(() => {});
      },
      setLaunchAtStartup: (launchAtStartup) => {
        set({ launchAtStartup });
        void hostSettingsPutValue('launchAtStartup', launchAtStartup).catch(() => {});
      },
      setTelemetryEnabled: (telemetryEnabled) => {
        set({ telemetryEnabled });
        void hostSettingsPutValue('telemetryEnabled', telemetryEnabled).catch(() => {});
      },
      setGatewayAutoStart: (gatewayAutoStart) => {
        set({ gatewayAutoStart });
        void hostSettingsPutValue('gatewayAutoStart', gatewayAutoStart).catch(() => {});
      },
      setGatewayPort: (gatewayPort) => {
        set({ gatewayPort });
        void hostSettingsPutValue('gatewayPort', gatewayPort).catch(() => {});
      },
      setProxyEnabled: (proxyEnabled) => set({ proxyEnabled }),
      setProxyServer: (proxyServer) => set({ proxyServer }),
      setProxyBypassRules: (proxyBypassRules) => set({ proxyBypassRules }),
      setUpdateChannel: (updateChannel) => {
        set({ updateChannel });
        void hostSettingsPutValue('updateChannel', updateChannel).catch(() => {});
      },
      setAutoCheckUpdate: (autoCheckUpdate) => {
        set({ autoCheckUpdate });
        void hostSettingsPutValue('autoCheckUpdate', autoCheckUpdate).catch(() => {});
      },
      setAutoDownloadUpdate: (autoDownloadUpdate) => {
        set({ autoDownloadUpdate });
        void hostSettingsPutValue('autoDownloadUpdate', autoDownloadUpdate).catch(() => {});
      },
      setSidebarCollapsed: (sidebarCollapsed) => {
        set({ sidebarCollapsed });
        void hostSettingsPutValue('sidebarCollapsed', sidebarCollapsed).catch(() => {});
      },
      setDevModeUnlocked: (devModeUnlocked) => {
        set({ devModeUnlocked });
        void hostSettingsPutValue('devModeUnlocked', devModeUnlocked).catch(() => {});
      },
      markSetupComplete: () => {
        set({ setupComplete: true });
        void hostSettingsPutValue('setupComplete', true).catch(() => {});
      },
      resetSettings: async () => {
        try {
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
        } catch {
          set({ ...defaultSettings, initialized: true });
        }
      },
    }),
    {
      name: 'clawx-settings',
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<SettingsState>),
        initialized: false,
      }),
    }
  )
);
