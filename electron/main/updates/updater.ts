/**
 * Auto-Updater Module
 * Handles automatic application updates using electron-updater
 *
 * Update providers are configured in electron-builder.yml.
 * For prerelease channels (alpha, beta), autoUpdater.channel controls
 * which metadata file will be requested (alpha.yml / beta.yml / latest.yml).
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { EventEmitter } from 'events';
import { setQuitting } from '../lifecycle/state';
import { isUpdateVersionNewer } from '../../../src/types/desktop/update-version';
import { UPDATE_SOURCE_AUTHORIZATION, UPDATE_SOURCE_URL } from './source';

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

export type UpdateDownloadAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; error: string }>;

export interface UpdaterEvents {
  'status-changed': (status: UpdateStatus) => void;
  'checking-for-update': () => void;
  'update-available': (info: UpdateInfo) => void;
  'update-not-available': (info: UpdateInfo) => void;
  'download-progress': (progress: ProgressInfo) => void;
  'update-downloaded': (event: UpdateDownloadedEvent) => void;
  'error': (error: Error) => void;
}

/**
 * Detect the update channel from a semver version string.
 * e.g. "0.1.8-alpha.0" → "alpha", "1.0.0-beta.1" → "beta", "1.0.0" → "latest"
 */
function detectChannel(version: string): string {
  const match = version.match(/-([a-zA-Z]+)/);
  return match ? match[1] : 'latest';
}

export class AppUpdater extends EventEmitter {
  private status: UpdateStatus = { status: 'idle' };
  private downloadInFlight: Promise<void> | undefined;

  constructor() {
    super();

    this.on('error', (error: Error) => {
      logger.error('[Updater] AppUpdater emitted error:', error);
    });
    
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.disableDifferentialDownload = true;
    
    autoUpdater.logger = {
      info: (msg: string) => logger.info('[Updater]', msg),
      warn: (msg: string) => logger.warn('[Updater]', msg),
      error: (msg: string) => logger.error('[Updater]', msg),
      debug: (msg: string) => logger.debug('[Updater]', msg),
    };

    // Use the publish provider configured in electron-builder.yml.
    const version = app.getVersion();
    const channel = detectChannel(version);
    logger.info(`[Updater] Version: ${version}, channel: ${channel}`);

    // Set channel so electron-updater requests the correct yml filename.
    // e.g. channel "alpha" → requests alpha-mac.yml, channel "latest" → requests latest-mac.yml
    autoUpdater.channel = channel;

    this.setupListeners();
  }

  configureUpdateSource(): void {
    // Keep credentials out of provider headers so redirects and absolute file URLs cannot inherit them.
    const source = new URL(UPDATE_SOURCE_URL);
    autoUpdater.netSession.webRequest.onBeforeSendHeaders(
      { urls: [`${UPDATE_SOURCE_URL}*`] },
      (details, callback) => {
        const url = new URL(details.url);
        const requestHeaders = { ...details.requestHeaders };
        if (url.origin === source.origin && url.pathname.startsWith(source.pathname)) {
          requestHeaders.authorization = UPDATE_SOURCE_AUTHORIZATION;
        }
        callback({ requestHeaders });
      },
    );
  }

  /**
   * Get current update status
   */
  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Setup auto-updater event listeners
   */
  private setupListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateStatus({ status: 'checking' });
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      if (!this.isNewerUpdate(info)) {
        this.updateStatus({ status: 'not-available' });
        this.emit('update-not-available', info);
        return;
      }

      this.updateStatus({ status: 'available', info });
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'not-available', info });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', progress });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      if (!this.isNewerUpdate(event)) {
        this.updateStatus({ status: 'not-available' });
        this.emit('update-not-available', event);
        return;
      }

      this.updateStatus({ status: 'downloaded', info: event });
      this.emit('update-downloaded', event);
    });

    autoUpdater.on('error', (error: Error) => {
      this.updateStatus({ status: 'error', error: error.message });
      this.emit('error', error);
    });
  }

  /**
   * Update status and notify subscribers
   */
  private updateStatus(newStatus: Partial<UpdateStatus>): void {
    const downloadedVersion = this.status.status === 'downloaded' ? this.status.info?.version : undefined;
    if (downloadedVersion && (
      newStatus.status === 'checking'
      || newStatus.status === 'not-available'
      || (newStatus.status === 'available'
        && (!newStatus.info || !isUpdateVersionNewer(newStatus.info.version, downloadedVersion)))
    )) return;

    this.status = {
      status: newStatus.status ?? this.status.status,
      info: newStatus.info,
      progress: newStatus.progress,
      error: newStatus.error,
    };
    this.emit('status-changed', this.status);
  }

  private isNewerUpdate(info: UpdateInfo): boolean {
    const currentVersion = app.getVersion();
    const isNewer = isUpdateVersionNewer(info.version, currentVersion);

    if (!isNewer) {
      logger.info(
        `[Updater] Ignoring update version ${info.version}; current version is ${currentVersion}`,
      );
    }

    return isNewer;
  }

  /**
   * Check for updates.
   *
   * In dev mode (not packed), autoUpdater.checkForUpdates() silently returns
   * null without emitting any events, so we must detect this and force a
   * final status so the UI never gets stuck in 'checking'.
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      const result = await autoUpdater.checkForUpdates();

      // In dev mode (app not packaged), autoUpdater silently returns null
      // without emitting ANY events (not even checking-for-update).
      // Detect this and force an error so the UI never stays silent.
      if (result == null) {
        this.updateStatus({
          status: 'error',
          error: 'Update check skipped (dev mode – app is not packaged)',
        });
        return null;
      }

      // Safety net: if events somehow didn't fire, force a final state.
      if (this.status.status === 'checking' || this.status.status === 'idle') {
        this.updateStatus({ status: 'not-available' });
      }

      return result.updateInfo || null;
    } catch (error) {
      logger.error('[Updater] Check for updates failed:', error);
      this.updateStatus({ status: 'error', error: (error as Error).message || String(error) });
      throw error;
    }
  }

  /**
   * Download available update
   */
  downloadUpdate(): UpdateDownloadAdmission {
    if (this.downloadInFlight) return { accepted: true };
    if (this.status.status !== 'available') {
      return { accepted: false, error: 'No available update to download.' };
    }

    const info = this.status.info;
    const download = Promise.resolve().then(() => autoUpdater.downloadUpdate()).then(
      () => { this.downloadInFlight = undefined; },
      () => {
        this.downloadInFlight = undefined;
        logger.warn('[Updater] Download update failed');
        if (this.status.status !== 'error') {
          this.updateStatus({ status: 'error', error: 'Failed to download update' });
        }
      },
    );
    this.downloadInFlight = download;
    this.updateStatus({ status: 'downloading', info });
    return { accepted: true };
  }

  /**
   * Install update and restart.
   *
   * On macOS, electron-updater delegates to Squirrel.Mac (ShipIt). The
   * native quitAndInstall() spawns ShipIt then internally calls app.quit().
   * However, the tray close handler in index.ts intercepts window close
   * and hides to tray unless isQuitting is true. Squirrel's internal quit
   * sometimes fails to trigger before-quit in time, so we set isQuitting
   * BEFORE calling quitAndInstall(). This lets the native quit flow close
   * the window cleanly while ShipIt runs independently to replace the app.
   */
  quitAndInstall(): void {
    logger.info('[Updater] quitAndInstall called');
    setQuitting();
    autoUpdater.quitAndInstall();
  }

  /**
   * Set update channel (stable, beta, dev)
   */
  setChannel(channel: 'stable' | 'beta' | 'dev'): void {
    autoUpdater.channel = channel;
  }

  /**
   * Get current version
   */
  getCurrentVersion(): string {
    return app.getVersion();
  }
}

// Export singleton instance
export const appUpdater = new AppUpdater();
