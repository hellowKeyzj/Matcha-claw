import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { IabEvent, IabUiRequest } from '../../../src/types/desktop/iab';
import { logger } from '../../utils/logger';
import { createIabSession } from './session';
import { resolveIabUserAgentOverride } from './user-agent';
import { IabHistory } from './history';
import { closePublicFaviconClient } from './favicon-fetch';
import { IabCookies } from './cookies';
import { IabDownloads } from './downloads';
import { IabManager } from './manager';
import { IabBroker } from './broker';
import { IabAutomationWorker } from './automation-client';
import { startIabAgentBridge } from './agent-bridge';
import type { RuntimeHostLifecycle } from '../runtime-host-delivery/lifecycle-owner';
import type { SettingsBrowserMode } from '../runtime-host-delivery/products/settings/desired';

export function createIab(input: {
  window(): BrowserWindow | null;
  emit(event: IabEvent): void;
  isAgentEnabled(): Promise<boolean>;
  runtime(): Promise<Pick<RuntimeHostLifecycle, 'command' | 'onDisconnect'>>;
}) {
  let control = new AbortController();
  let modeWrites = 0;
  let modeUnconfirmed = false;
  const invalidateAgentControl = () => {
    control.abort(Object.assign(new Error('Browser control changed; the request was not replayed'), { code: 'IAB_CONTROL_CHANGED' }));
    control = new AbortController();
  };
  const root = join(app.getPath('userData'), 'iab');
  let broker!: IabBroker;
  const browserSession = createIabSession({
    readClientHintsPolicy: (contents, expression, signal) => broker.readClientHintsPolicy(contents, expression, signal),
  });
  const history = new IabHistory(root);
  const cookies = new IabCookies(root, browserSession.session, logger);
  const downloads = new IabDownloads(root, browserSession.session, {
    directory: () => app.getPath('downloads'), window: input.window, log: logger,
    onCompleted: (tabId, download) => {
      const ownerId = manager.getOwner(tabId);
      if (ownerId) input.emit({ type: 'download-completed', ownerId, tabId, download });
      void manager.pageTools.notifyDownload(tabId, download).catch((error) => logger.warn(`[iab] Download notification failed: ${String(error)}`));
    },
  });
  const data = { history, cookies, downloads };
  const cookiesReady = cookies.initialize().catch((error) => logger.warn(`[iab] Session cookie restore failed: ${String(error)}`));
  void history.initialize().catch((error) => logger.warn(`[iab] History initialization failed: ${String(error)}`));
  void downloads.initialize().catch((error) => logger.warn(`[iab] Download recovery initialization failed: ${String(error)}`));
  const ready = Promise.all([browserSession.ready, cookiesReady]).then(() => undefined);
  void ready.catch((error) => logger.error('[iab] Browser initialization failed', error));
  const manager: IabManager = new IabManager({
    window: input.window, session: browserSession.session, data, ready, log: logger, emit: input.emit,
    prepareCdp: (tabId, ownerId, contents) => broker.prepareTarget(tabId, ownerId, contents),
    releaseClaim: (tabId, executorId) => automation.releaseClaim(tabId, executorId),
  });
  broker = new IabBroker({
    resolveTarget: (tabId, ownerId) => manager.resolveBrokerTarget(tabId, ownerId),
    resolveUserAgentOverride: () => resolveIabUserAgentOverride(), downloads, log: logger,
  });
  const automation = new IabAutomationWorker({ manager, broker, log: logger });
  const subscriptions = [
    history.subscribe(() => input.emit({ type: 'history-changed' })),
    downloads.subscribe(() => input.emit({ type: 'downloads-changed' })),
  ];
  const bridge = startIabAgentBridge({
    automation, ready, isEnabled: input.isAgentEnabled, runtime: input.runtime,
    cleanupSession: (executorId, principalId, scope) => manager.cleanupSession(executorId, principalId, scope),
    controlSignal: () => control.signal,
    assertControlCurrent: () => {
      if (modeWrites || modeUnconfirmed) throw Object.assign(new Error(modeUnconfirmed
        ? 'Browser mode could not be confirmed; save browser settings again before using agent control'
        : 'Browser mode is changing'), { code: modeUnconfirmed ? 'IAB_MODE_UNCONFIRMED' : 'IAB_MODE_CHANGING' });
    },
  });
  void bridge.catch((error) => logger.error('[iab] Agent bridge initialization failed', error));
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    invalidateAgentControl,
    async prepareQuit(): Promise<void> {
      try { await history.flush(); }
      catch (error) { logger.warn(`[iab] History flush failed: ${String(error)}`); }
      try { await downloads.prepareForQuit(); }
      catch (error) {
        downloads.cancelQuit();
        throw Object.assign(new AggregateError([error], 'Download history could not be saved before quitting', { cause: error }), { code: 'DOWNLOAD_HISTORY_FLUSH_FAILED' });
      }
      try { await cookies.flush(); }
      catch (error) { logger.warn(`[iab] Cookie flush failed: ${String(error)}`); }
    },
    cancelQuit(): void { downloads.cancelQuit(); },
    beginBrowserModeChange(mode: SettingsBrowserMode): (accepted: boolean) => void {
      const leavingIab = mode !== 'iab';
      if (leavingIab) { modeWrites++; invalidateAgentControl(); }
      let ended = false;
      return (accepted) => {
        if (ended) return;
        ended = true;
        if (leavingIab) modeWrites--;
        if (accepted) modeUnconfirmed = false;
        else if (leavingIab) modeUnconfirmed = true;
      };
    },
    snapshot() { if (closed) throw new Error('In-app browser is closed'); return manager.snapshot(); },
    async command(request: IabUiRequest) {
      if (closed) throw new Error('In-app browser is closed');
      // Selection/hide do not wait for disk or extension readiness; no page is loaded before ready.
      return manager.execute(request.command);
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true;
        control.abort(new Error('In-app browser is closing'));
        manager.setVisible(false);
        const failures: unknown[] = [];
        const settle = async (operation: () => void | Promise<unknown>) => {
          try { await operation(); } catch (error) { failures.push(error); }
        };
        await settle(async () => (await bridge).close());
        await settle(() => automation.dispose());
        await settle(() => ready);
        await settle(() => history.close());
        await settle(() => closePublicFaviconClient());
        await settle(() => history.flush());
        await settle(() => downloads.prepareForQuit());
        await settle(() => downloads.flush());
        await settle(() => cookies.flush());
        for (const unsubscribe of subscriptions) unsubscribe();
        broker.dispose();
        manager.dispose();
        downloads.dispose();
        cookies.dispose();
        await settle(() => browserSession.flush());
        browserSession.dispose();
        if (failures.length) throw new AggregateError(failures, 'In-app browser shutdown did not fully persist its data');
      })();
    },
  };
}

export type IabApplication = ReturnType<typeof createIab>;
