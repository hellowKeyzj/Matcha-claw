import { ipcMain } from 'electron';
import type { RuntimeHostManager } from '../runtime-host-manager';

export function registerUsageHandlers(runtimeHost: RuntimeHostManager): void {
  ipcMain.handle('usage:recentTokenHistory', async (_, limit?: number) => {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(Math.floor(limit), 1)
      : undefined;
    const result = await runtimeHost.request(
      'GET',
      '/api/runtime-host/usage/recent',
      { limit: safeLimit },
    );
    if (result.status >= 400) {
      throw new Error(`Runtime Host usage request failed (${result.status})`);
    }
    return result.data;
  });
}
