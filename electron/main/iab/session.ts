import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, session } from 'electron';
import type { IabSession, IabSessionOptions } from './contracts';
import { installIabClientHints } from './client-hints';
import { initializeIabUserAgent, resolveIabUserAgentOverride } from './user-agent';

export const IAB_PARTITION = 'persist:agent-iab';
const PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

export function createIabSession(options: IabSessionOptions): IabSession {
  const shared = session.fromPartition(IAB_PARTITION);
  shared.setUserAgent(resolveIabUserAgentOverride().userAgent);
  shared.setPermissionCheckHandler((_contents, permission) => PERMISSIONS.has(permission));
  shared.setPermissionRequestHandler((_contents, permission, callback) => callback(PERMISSIONS.has(permission)));
  let removeClientHints: (() => void) | undefined;
  let disposed = false;
  let extensionId: string | undefined;
  const ready = (async () => {
    await initializeIabUserAgent();
    if (disposed) throw new Error('IAB session was disposed before browser identity was ready');
    removeClientHints = installIabClientHints(shared, options.readClientHintsPolicy);
    const source = app.isPackaged
      ? join(process.resourcesPath, 'iab-guard-extension')
      : join(app.getAppPath(), 'build', 'iab-guard-extension');
    const target = join(app.getPath('userData'), 'iab-guard-extension');
    const [manifest, guard] = await Promise.all([
      readFile(join(source, 'manifest.json'), 'utf8'), readFile(join(source, 'guard.js'), 'utf8'),
    ]);
    await mkdir(target, { recursive: true });
    await Promise.all([writeFile(join(target, 'manifest.json'), manifest), writeFile(join(target, 'guard.js'), guard)]);
    if (disposed) throw new Error('IAB session was disposed before page guards were ready');
    const extension = await shared.extensions.loadExtension(target, { allowFileAccess: false });
    extensionId = extension.id;
    if (disposed) {
      shared.extensions.removeExtension(extension.id);
      throw new Error('IAB session was disposed while loading page guards');
    }
  })();
  // Readiness failures remain visible to bootstrap and every tab; never load an unguarded page.
  void ready.catch(() => {});
  return {
    session: shared,
    ready,
    async flush() { await ready; await shared.cookies.flushStore(); shared.flushStorageData(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeClientHints?.();
      if (extensionId) shared.extensions.removeExtension(extensionId);
      shared.setPermissionCheckHandler(() => false);
      shared.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    },
  };
}
