import { enterLocalWorkspace, expect, test } from './fixtures/electron';
import type { Locator } from '@playwright/test';

async function ensureSwitchState(
  toggle: Locator,
  desiredChecked: boolean,
): Promise<void> {
  const current = (await toggle.getAttribute('data-state')) === 'checked';
  if (current !== desiredChecked) {
    await toggle.click();
  }
}

test.describe('MatchaClaw developer proxy settings', () => {
  test('禁用代理时仍可保存', async ({ page }) => {
    await enterLocalWorkspace(page);
    await page.evaluate(() => {
      window.location.hash = '#/settings?section=gateway';
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
    await page.getByRole('textbox', { name: '代理服务器' }).fill('http://127.0.0.1:7890');
    await expect(proxySaveButton).toBeEnabled();
    await proxySaveButton.click();
    await expect(proxySaveButton).toBeDisabled();

    await ensureSwitchState(proxyToggle, false);
    await expect(proxySaveButton).toBeEnabled();
    await proxySaveButton.click();
    await expect(proxySaveButton).toBeDisabled();
  });
});
