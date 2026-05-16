import { expect, test } from '../fixtures/electron';
import type { Page } from '@playwright/test';

async function ensureSetupComplete(page: Page): Promise<void> {
  await page.evaluate(() => {
    const storageKey = 'matchaclaw-settings';
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

function visibleByTestId(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`).first();
}

function visibleMonacoEditorBackground(page: Page) {
  return page.locator('.monaco-editor-background:visible').first();
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

  test('artifact workbench navigates generated files, rich previews, and workspace skill files', async ({ page }) => {
    await bootChat(page);

    const sessionList = page.getByTestId('session-list-scroll-area');
    await sessionList.getByText('Artifact Session').click();

    await expect(page.getByTestId('chat-execution-graph')).toBeVisible();

    const sidePanel = page.getByTestId('chat-side-panel');
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId('chat-side-panel-tab-artifacts')).toHaveAttribute('data-state', 'active');
    await expect(sidePanel.getByRole('button', { name: /demo\.ts/i }).first()).toBeVisible();
    await page.getByTestId('execution-graph-artifact-edit-1').click();
    await expect(sidePanel.getByText('export const value = 1;').first()).toBeVisible();
    await expect(sidePanel.getByText('export const value = 2;').first()).toBeVisible();
    await expect(sidePanel.getByTestId('artifact-preview-next-file')).toBeVisible();

    await sidePanel.getByTestId('chat-side-panel-artifact-fullscreen-toggle').click();
    await expect(page.getByTestId('chat-artifact-workbench-fullscreen')).toBeVisible();
    await expect(page.getByTestId('chat-workspace-host')).toHaveAttribute('data-takeover-mode', 'artifact-workbench');
    await expect(page.getByTestId('agent-sessions-pane')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /新对话|New Chat/i })).toHaveCount(0);
    await sidePanel.getByTestId('chat-side-panel-artifact-fullscreen-toggle').click();
    await expect(page.getByTestId('chat-artifact-workbench-fullscreen')).toHaveCount(0);
    await expect(page.getByTestId('chat-workspace-host')).toHaveAttribute('data-takeover-mode', 'none');
    await expect(page.getByTestId('agent-sessions-pane')).toBeVisible();
    await expect(page.getByRole('button', { name: /新对话|New Chat/i })).toBeVisible();

    await sidePanel.getByTestId('artifact-preview-next-file').click();
    await expect(sidePanel).toContainText('report.pdf');
    await expect(page.getByTestId('pdf-viewer')).toBeVisible();
    await expect(sidePanel.getByTestId('chat-artifact-section-changes')).toBeDisabled();

    await sidePanel.getByTestId('artifact-preview-next-file').click();
    await expect(sidePanel).toContainText('sales.xlsx');
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Summary' })).toBeVisible();
    await expect(sidePanel.getByTestId('chat-artifact-section-changes')).toBeDisabled();

    await sidePanel.getByTestId('artifact-preview-prev-file').click();
    await expect(page.getByTestId('pdf-viewer')).toBeVisible();

    await sidePanel.getByTestId('chat-artifact-section-workspace').click();
    await expect(sidePanel.getByTestId('workspace-browser-body')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: /demo\.ts/i }).first()).toBeVisible();
    await expect(sidePanel.getByTestId('workspace-browser-body')).not.toContainText('/workspace');
    await expect(page.locator('[data-testid="workspace-tree-select-toggle"]')).toHaveCount(0);

    await sidePanel.getByTestId('chat-artifact-section-workspace').click();
    await expect(sidePanel.getByRole('button', { name: /demo\.ts/i }).first()).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: /report\.pdf/i }).first()).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: /sales\.xlsx/i }).first()).toBeVisible();
  });

  test('artifact diff viewer keeps light-theme background aligned with the app shell', async ({ page }) => {
    await bootChat(page);

    await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.remove('dark');
      root.classList.add('light');
    });

    const sessionList = page.getByTestId('session-list-scroll-area');
    await sessionList.getByText('Artifact Session').click();

    await page.getByTestId('execution-graph-artifact-edit-1').click();
    const diffBackground = visibleMonacoEditorBackground(page);
    await expect(diffBackground).toBeVisible({ timeout: 30_000 });

    const colors = await diffBackground.evaluate((element) => {
      return {
        diffBackground: window.getComputedStyle(element).backgroundColor,
        appBackground: window.getComputedStyle(document.body).backgroundColor,
      };
    });

    expect(colors.diffBackground).toBe(colors.appBackground);
    expect(colors.diffBackground).not.toBe('rgb(255, 255, 255)');
  });

  test('artifact workbench supports group-level open and workspace browsing without multi-select', async ({ page }) => {
    await bootChat(page);

    const sessionList = page.getByTestId('session-list-scroll-area');
    await sessionList.getByText('Artifact Session').click();

    const sidePanel = page.getByTestId('chat-side-panel');
    await expect(sidePanel).toBeVisible();

    await sidePanel.getByRole('button', { name: '打开最新' }).first().click();
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();

    await sidePanel.getByRole('button', { name: /demo\.ts/i }).first().click();
    await sidePanel.getByTestId('chat-artifact-section-workspace').click();
    await expect(sidePanel.getByTestId('workspace-browser-body')).toBeVisible();
    await expect(page.locator('[data-testid="workspace-tree-select-toggle"]')).toHaveCount(0);
    await expect(sidePanel.getByRole('button', { name: /demo\.ts/i }).first()).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: /report\.pdf/i }).first()).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: /sales\.xlsx/i }).first()).toBeVisible();
    await expect(sidePanel.getByTestId('workspace-browser-body')).not.toContainText('/workspace');
  });
});
