/**
 * Update State Store
 * Manages application update state
 */
import { create } from 'zustand';
import { useSettingsStore } from './settings';
import { invokeIpc } from '@/lib/api-client';
import { isUpdateVersionNewer } from '../../runtime-host/shared/update-version';

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
}

export interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export type UpdateStatus = 
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: string | null;
  isInitialized: boolean;

  // Actions
  init: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => void;
  setChannel: (channel: 'stable' | 'beta' | 'dev') => Promise<void>;
  clearError: () => void;
}

let updateInitPromise: Promise<void> | null = null;

function normalizeUpdateStatus(
  currentVersion: string,
  status: {
    status: UpdateStatus;
    info?: UpdateInfo;
    progress?: ProgressInfo;
    error?: string;
  },
): Pick<UpdateState, 'status' | 'updateInfo' | 'progress' | 'error'> {
  if (
    (status.status === 'available' || status.status === 'downloaded')
    && status.info
    && !isUpdateVersionNewer(status.info.version, currentVersion)
  ) {
    return {
      status: 'not-available',
      updateInfo: null,
      progress: null,
      error: null,
    };
  }

  return {
    status: status.status,
    updateInfo: status.info || null,
    progress: status.progress || null,
    error: status.error || null,
  };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  currentVersion: '0.0.0',
  updateInfo: null,
  progress: null,
  error: null,
  isInitialized: false,

  init: async () => {
    if (get().isInitialized) return;
    if (updateInitPromise) return updateInitPromise;

    updateInitPromise = (async () => {
      try {
        const version = await invokeIpc<string>('update:version');
        set({ currentVersion: version as string });
      } catch (error) {
        console.error('Failed to get version:', error);
      }

      try {
        const status = await invokeIpc<{
          status: UpdateStatus;
          info?: UpdateInfo;
          progress?: ProgressInfo;
          error?: string;
        }>('update:status');
        set(normalizeUpdateStatus(get().currentVersion, status));
      } catch (error) {
        console.error('Failed to get update status:', error);
      }

      const ipcRenderer = window.electron?.ipcRenderer;
      if (typeof ipcRenderer?.on === 'function') {
        ipcRenderer.on('update:status-changed', (data) => {
          const status = data as {
            status: UpdateStatus;
            info?: UpdateInfo;
            progress?: ProgressInfo;
            error?: string;
          };
          set(normalizeUpdateStatus(get().currentVersion, status));
        });
      }

      set({ isInitialized: true });

      if (useSettingsStore.getState().autoCheckUpdate) {
        setTimeout(() => {
          get().checkForUpdates().catch(() => {});
        }, 10000);
      }
    })();

    try {
      await updateInitPromise;
    } finally {
      if (get().isInitialized) {
        updateInitPromise = null;
      }
    }
  },

  checkForUpdates: async () => {
    set({ status: 'checking', error: null });
    
    try {
      const result = await Promise.race([
        invokeIpc('update:check'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Update check timed out')), 30000))
      ]) as {
        success: boolean;
        error?: string;
        status?: {
          status: UpdateStatus;
          info?: UpdateInfo;
          progress?: ProgressInfo;
          error?: string;
        };
      };
      
      if (result.status) {
        set(normalizeUpdateStatus(get().currentVersion, result.status));
      } else if (!result.success) {
        set({ status: 'error', error: result.error || 'Failed to check for updates' });
      }
    } catch (error) {
      set({ status: 'error', error: String(error) });
    } finally {
      // In dev mode autoUpdater skips without emitting events, so the
      // status may still be 'checking' or even 'idle'. Catch both.
      const currentStatus = get().status;
      if (currentStatus === 'checking' || currentStatus === 'idle') {
        set({ status: 'error', error: 'Update check completed without a result. This usually means the app is running in dev mode.' });
      }
    }
  },

  downloadUpdate: async () => {
    set({ status: 'downloading', error: null });
    
    try {
      const result = await invokeIpc<{
        success: boolean;
        error?: string;
      }>('update:download');
      
      if (!result.success) {
        set({ status: 'error', error: result.error || 'Failed to download update' });
      }
    } catch (error) {
      set({ status: 'error', error: String(error) });
    }
  },

  installUpdate: () => {
    void invokeIpc('update:install');
  },

  setChannel: async (channel) => {
    try {
      await invokeIpc('update:setChannel', channel);
    } catch (error) {
      console.error('Failed to set update channel:', error);
    }
  },

  clearError: () => set({ error: null, status: 'idle' }),
}));
