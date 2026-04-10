import { expect, test } from './fixtures/electron';
import type { Locator, Page } from '@playwright/test';

async function ensureSwitchState(
  toggle: Locator,
  desiredChecked: boolean,
): Promise<void> {
  const current = (await toggle.getAttribute('data-state')) === 'checked';
  if (current !== desiredChecked) {
    await toggle.click();
  }
}

async function ensureSetupComplete(page: Page): Promise<void> {
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

test.describe('ClawX developer proxy settings', () => {
  test('禁用代理时仍可保存', async ({ page }) => {
    await ensureSetupComplete(page);
    await page.evaluate(() => {
      window.history.pushState({}, '', '/settings?section=gateway');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.locator('nav[aria-label] button').first().click();

    const expandButton = page.getByTestId('settings-proxy-expand');
    await expect(expandButton).toBeVisible();
    await expandButton.click();

    const proxySection = page.getByTestId('settings-proxy-section');
    const proxyToggle = page.getByTestId('settings-proxy-toggle');
    const proxySaveButton = page.getByTestId('settings-proxy-save-button');

    await expect(proxySection).toBeVisible();
    await expect(proxyToggle).toBeVisible();
    await expect(proxySaveButton).toBeDisabled();

    await ensureSwitchState(proxyToggle, true);
    await expect(proxySaveButton).toBeEnabled();
    await proxySaveButton.click();
    await expect(proxySaveButton).toBeDisabled();

    await ensureSwitchState(proxyToggle, false);
    await expect(proxySaveButton).toBeEnabled();
    await proxySaveButton.click();
    await expect(proxySaveButton).toBeDisabled();
  });
});
