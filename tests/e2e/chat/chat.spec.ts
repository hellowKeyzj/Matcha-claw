import { expect, test } from '../fixtures/electron';
import type { Page } from '@playwright/test';

async function ensureSetupComplete(page: Page): Promise<void> {
  await page.evaluate(() => {
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
  });
}

async function bootChat(page: Page): Promise<void> {
  await ensureSetupComplete(page);
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

test.describe('Chat e2e', () => {
  test('发送后进入流式并完成最终回复', async ({ page }) => {
    await bootChat(page);

    const input = page.locator('textarea');
    await input.fill('e2e default message');
    await page.getByTitle('Send').click();

    await expect(page.getByTitle('Stop')).toBeVisible();
    await expect(page.getByText('Mock reply: e2e default message')).toBeVisible();
    await expect(page.getByTitle('Send')).toBeVisible();
  });

  test('审批等待可展示并允许后继续完成', async ({ page }) => {
    await bootChat(page);

    const input = page.locator('textarea');
    await input.fill('[approval] need approval');
    await page.getByTitle('Send').click();

    const approvalDock = page.getByTestId('chat-approval-dock');
    await expect(approvalDock).toBeVisible();
    await approvalDock.locator('button').first().click();

    await expect(page.getByText('Approved result')).toBeVisible();
    await expect(approvalDock).toBeHidden();
  });

  test('长任务可中断并回到可发送状态', async ({ page }) => {
    await bootChat(page);

    const input = page.locator('textarea');
    await input.fill('[long] keep running');
    await page.getByTitle('Send').click();

    await expect(page.getByTitle('Stop')).toBeVisible();
    await page.getByTitle('Stop').click();
    await expect(page.getByTitle('Send')).toBeVisible();
  });

  test('会话切换可在历史会话与主会话之间往返', async ({ page }) => {
    await bootChat(page);

    const input = page.locator('textarea');
    await input.fill('main session text');
    await page.getByTitle('Send').click();
    await expect(page.getByText('Mock reply: main session text')).toBeVisible();

    const sessionList = page.getByTestId('session-list-scroll-area');
    await sessionList.getByText('History Session').click();
    await expect(page.getByRole('main').getByText('History session seed message', { exact: true })).toBeVisible();

    await page.getByTestId('agent-item-main').click();
    await expect(page.getByText('main session text', { exact: true })).toBeVisible();
  });

  test('附件上传后可走发送链路并渲染附件消息', async ({ page }) => {
    await bootChat(page);

    await page.getByTitle('Attach files').click();
    await expect(page.getByText('notes.txt')).toBeVisible();

    const input = page.locator('textarea');
    await input.fill('send with attachment');
    await page.getByTitle('Send').click();

    await expect(page.getByText('Mock reply: send with attachment')).toBeVisible();
  });
});
