import { app, type Details } from 'electron';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphicsChangeResult, GraphicsSettingsState } from '../../../src/types/desktop/graphics';
import { logger } from '../../utils/logger';
import type { QuitCleanupResult } from '../lifecycle/quit';

type GraphicsMode = 'enabled' | 'disabled' | 'recovery';
type PendingGraphicsChange =
  | { phase: 'requested'; mode: GraphicsMode; resolve: (result: GraphicsChangeResult) => void }
  | { phase: 'committed' };

function readMode(path: string): GraphicsMode {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && 'mode' in value
      && (value.mode === 'enabled' || value.mode === 'disabled' || value.mode === 'recovery')) {
      return value.mode;
    }
    throw new Error('Invalid graphics settings');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'enabled';
    logger.warn('[Graphics] Settings could not be read; using software rendering:', error);
    return 'recovery';
  }
}

function writeMode(path: string, mode: GraphicsMode): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createGraphicsController(input: {
  isShuttingDown: () => boolean;
}) {
  const supported = process.platform === 'win32';
  const path = join(app.getPath('userData'), 'graphics.json');
  let mode = supported ? readMode(path) : 'disabled';
  const disabledByArgument = app.commandLine.hasSwitch('disable-gpu');
  const enabledAtStartup = supported && mode === 'enabled' && !disabledByArgument;
  if (supported) app.commandLine.appendSwitch('disable-gpu-sandbox');
  if (!enabledAtStartup) app.disableHardwareAcceleration();

  let pendingChange: PendingGraphicsChange | undefined;
  let lastRecoveryAttempt = 0;
  let crashes: number[] = [];

  const cancelRestart = (reason: 'save-failed' | 'quit-cancelled'): void => {
    const change = pendingChange;
    pendingChange = undefined;
    if (change?.phase === 'requested') change.resolve({ status: 'blocked', reason });
  };

  const changeMode = async (nextMode: GraphicsMode): Promise<GraphicsChangeResult> => {
    if (!supported) return { status: 'blocked', reason: 'unsupported' };
    if (pendingChange || input.isShuttingDown()) return { status: 'blocked', reason: 'busy' };
    if (nextMode === mode && !(nextMode === 'enabled' && disabledByArgument)) return { status: 'unchanged' };
    return new Promise<GraphicsChangeResult>((resolve) => {
      pendingChange = { phase: 'requested', mode: nextMode, resolve };
      app.quit();
    });
  };

  const onChildProcessGone = (_event: Electron.Event, details: Details) => {
    if (!enabledAtStartup || pendingChange || input.isShuttingDown()
      || details.type !== 'GPU' || details.reason !== 'crashed') return;
    const now = Date.now();
    if (lastRecoveryAttempt && now - lastRecoveryAttempt < 90_000) return;
    crashes = crashes.filter(at => now - at <= 30_000);
    crashes.push(now);
    if (crashes.length < 6) return;
    lastRecoveryAttempt = now;
    crashes = [];
    logger.warn('[Graphics] GPU repeatedly crashed; requesting software rendering recovery');
    void changeMode('recovery').then(result => {
      if (result.status === 'blocked') logger.error('[Graphics] Recovery restart blocked:', result.reason);
    }).catch(error => logger.error('[Graphics] Recovery restart failed:', error));
  };
  if (supported) app.on('child-process-gone', onChildProcessGone);

  return {
    readState(): GraphicsSettingsState {
      return {
        supported,
        enabled: enabledAtStartup,
        automaticallyDisabled: mode === 'recovery',
        hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
      };
    },
    setEnabled(enabled: boolean): Promise<GraphicsChangeResult> {
      return changeMode(enabled ? 'enabled' : 'disabled');
    },
    cancelRestart,
    async commitRestart(): Promise<boolean> {
      const change = pendingChange;
      if (change?.phase !== 'requested') return true;
      try {
        writeMode(path, change.mode);
      } catch (error) {
        logger.error('[Graphics] Rendering mode could not be saved:', error);
        cancelRestart('save-failed');
        return false;
      }
      mode = change.mode;
      pendingChange = { phase: 'committed' };
      logger.info('[Graphics] Saved rendering mode:', mode);
      change.resolve({ status: 'restarting' });
      // Deliver the IPC receipt before the quit owner destroys its renderer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return true;
    },
    relaunchAfterQuit(result: QuitCleanupResult): void {
      if (pendingChange?.phase !== 'committed' || result.outcome === 'unconfirmed') return;
      app.relaunch({
        args: process.argv.slice(1).filter((arg) => arg !== '--disable-gpu' && !arg.startsWith('--disable-gpu=')),
      });
    },
    dispose(): void {
      app.removeListener('child-process-gone', onChildProcessGone);
      crashes = [];
    },
  };
}

export type GraphicsController = ReturnType<typeof createGraphicsController>;
