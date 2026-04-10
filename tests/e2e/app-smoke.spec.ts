import { expect, test } from './fixtures/electron';
import type { Page } from '@playwright/test';

async function ensureSetupComplete(page: Page) {
  await page.evaluate(async () => {
    const storageKey = 'clawx-settings';
    const raw = window.localStorage.getItem(storageKey);
    let parsed: { state?: Record<string, unknown>; version?: number } = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number };
      } catch {
        parsed = {};
      }
    }
    parsed.state = { ...(parsed.state ?? {}), setupComplete: true };
    parsed.version = typeof parsed.version === 'number' ? parsed.version : 0;
    window.localStorage.setItem(storageKey, JSON.stringify(parsed));

    const putResponse = await window.electron.ipcRenderer.invoke('hostapi:fetch', {
      path: '/api/settings/setupComplete',
      method: 'PUT',
      body: { value: true },
    }) as { ok?: boolean; data?: { ok?: boolean; status?: number } };
    if (!putResponse?.ok || putResponse.data?.ok === false) {
      throw new Error(`failed to set setupComplete via hostapi:fetch (status=${putResponse?.data?.status ?? 'unknown'})`);
    }
    const getResponse = await window.electron.ipcRenderer.invoke('hostapi:fetch', {
      path: '/api/settings/setupComplete',
      method: 'GET',
    }) as { ok?: boolean; data?: { ok?: boolean; status?: number; json?: { value?: unknown } } };
    if (!getResponse?.ok || getResponse.data?.ok === false || getResponse.data?.json?.value !== true) {
      throw new Error(`setupComplete verification failed: ${JSON.stringify(getResponse?.data?.json ?? null)}`);
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test.describe('ClawX Electron smoke', () => {
  test('应用可启动并渲染设置页', async ({ page }) => {
    await ensureSetupComplete(page);
    await page.evaluate(() => {
      window.history.pushState({}, '', '/settings?section=gateway');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page).toHaveURL(/\/settings/);
  });
});
