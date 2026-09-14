import { enterLocalWorkspace, expect, readE2EOpenClawState, test } from '../fixtures/electron';
import type { Page } from '@playwright/test';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5KQAAAABJRU5ErkJggg==';

async function bootChat(page: Page): Promise<void> {
  await enterLocalWorkspace(page);
  await page.evaluate(() => { window.location.hash = '#/'; });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

async function createOpenClawSession(page: Page): Promise<void> {
  const sessionList = page.getByTestId('session-list-scroll-area');
  const newSession = page.getByRole('button', { name: /新会话|New session/i });
  await expect(page.getByTestId('session-list-error')).toHaveCount(0, { timeout: 30_000 });
  await expect(newSession).toBeEnabled({ timeout: 30_000 });
  const initialCount = await sessionList.getByRole('button').count();
  await newSession.click();
  await expect.poll(async () => sessionList.getByRole('button').count()).toBeGreaterThan(initialCount);
}

async function openWorkspaceBrowser(page: Page) {
  const sidePanel = page.getByTestId('chat-side-panel');
  if (!(await sidePanel.isVisible())) {
    await page.getByRole('button', { name: /打开右侧栏|Open side panel/i }).click();
    await expect(sidePanel).toBeVisible();
  }
  await sidePanel.getByTestId('chat-side-panel-tab-artifacts').click();
  await sidePanel.getByTestId('chat-artifact-section-workspace').click();
  await expect(sidePanel.getByTestId('workspace-browser-body')).toBeVisible();
  return sidePanel;
}

async function dropPngAttachment(page: Page): Promise<void> {
  await page.locator('textarea').evaluate((target, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const file = new File([bytes], 'e2e-attachment.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    target.closest('.w-full')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, TINY_PNG_BASE64);
}

async function invokeHostCapability(page: Page, body: unknown): Promise<unknown> {
  return await page.evaluate(async (body) => {
    const electron = (window as Window & {
      electron?: { ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } };
    }).electron;
    return await electron?.ipcRenderer?.invoke?.('hostapi:fetch', {
      requestId: crypto.randomUUID(),
      path: '/api/capabilities/execute',
      method: 'POST',
      body,
      timeoutMs: 120_000,
    }) ?? null;
  }, body);
}

async function stageRendererAttachment(page: Page, input: {
  base64: string;
  fileName: string;
  mimeType: string;
}): Promise<{
  stagedAttachmentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}> {
  const staged = await page.evaluate(async (input) => {
    const electron = (window as Window & {
      electron?: { ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } };
    }).electron;
    return await electron?.ipcRenderer?.invoke?.(
      'dialog:stageRendererBufferAttachment', input,
    ) ?? null;
  }, input);
  expect(staged).toMatchObject({
    stagedAttachmentId: expect.any(String),
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: expect.any(Number),
  });
  const stagedAttachment = staged as {
    stagedAttachmentId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
  };
  return {
    stagedAttachmentId: stagedAttachment.stagedAttachmentId,
    fileName: stagedAttachment.fileName,
    mimeType: stagedAttachment.mimeType,
    fileSize: stagedAttachment.fileSize,
  };
}

async function createOpenClawSessionThroughCapability(page: Page): Promise<{
  sessionKey: string;
  endpoint: { kind: 'native-runtime'; runtimeAdapterId: 'openclaw'; runtimeInstanceId: 'local' };
}> {
  const endpoint = {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw' as const,
    runtimeInstanceId: 'local' as const,
  };
  await expect.poll(async () => await invokeHostCapability(page, {
    id: 'session.management',
    operationId: 'sessions.list',
    scope: { kind: 'runtime-instance', endpoint },
    target: { kind: 'runtime-endpoint' },
    input: { endpoint },
  }), { timeout: 45_000 }).toMatchObject({
    ok: true,
    data: { status: 200, ok: true, json: { sessions: expect.any(Array) } },
  });
  const endpointSessionId = `e2e-attachment-${crypto.randomUUID()}`;
  const response = await invokeHostCapability(page, {
    id: 'session.prompt',
    operationId: 'sessions.create',
    scope: { kind: 'agent', endpoint, agentId: 'main' },
    target: { kind: 'agent', agentId: 'main' },
    input: { endpoint, agentId: 'main', endpointSessionId },
  });
  const sessionKey = `agent:main:${endpointSessionId}`;
  expect(response).toMatchObject({
    ok: true,
    data: { status: 200, ok: true, json: { outcome: 'succeeded', sessionKey } },
  });
  return { sessionKey, endpoint };
}

test.describe('Chat e2e', () => {
  test('creates an OpenClaw session and previews its isolated workspace through Electron Main and Rust Host', async ({ page }) => {
    await bootChat(page);
    await createOpenClawSession(page);

    const sidePanel = await openWorkspaceBrowser(page);
    const workspace = sidePanel.getByTestId('workspace-browser-body');
    await expect(workspace.getByRole('button', { name: 'AGENTS.md' })).toBeVisible();
    await expect(workspace).not.toContainText('e2e-profile-closure-2');

    await workspace.getByRole('button', { name: 'AGENTS.md' }).click();
    await expect(sidePanel.getByText('AGENTS.md', { exact: true }).last()).toBeVisible();
    await expect(workspace.getByText(/You are|workspace/i).first()).toBeVisible();
  });

  test('stages and sends an image attachment without exposing its owned path', async ({ page, electronApp }) => {
    await bootChat(page);
    await createOpenClawSession(page);

    await dropPngAttachment(page);
    await expect(page.getByText('e2e-attachment.png', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('stagedPath');
    await expect(page.locator('body')).not.toContainText('attachment-staging');

    await page.locator('textarea').fill('Describe this image.');
    await page.getByRole('button', { name: 'Send' }).click();
    const messageStack = page.getByTestId('chat-message-stack');
    await expect(messageStack.getByText('Describe this image.', { exact: true }),
      `OpenClaw state: ${JSON.stringify(await readE2EOpenClawState(electronApp))}`,
    ).toBeVisible({ timeout: 15_000 });
    await expect(messageStack.locator('img[src^="blob:"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('attachment-staging');
  });

  test('delivers a fixed PNG through the public session capability without leaking custody details', async ({ page, electronApp }) => {
    const { sessionKey, endpoint } = await createOpenClawSessionThroughCapability(page);
    const attachment = await stageRendererAttachment(page, {
      base64: TINY_PNG_BASE64,
      fileName: 'fixed-profile.png',
      mimeType: 'image/png',
    });
    const identity = { endpoint, agentId: 'main', sessionKey };

    const textOnlyResponse = await invokeHostCapability(page, {
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey,
        sessionIdentity: identity,
        message: 'Verify the session send baseline.',
        runId: `e2e-attachment-baseline-${crypto.randomUUID()}`,
        attachments: [],
      },
    });
    expect(
      textOnlyResponse,
      `OpenClaw state: ${JSON.stringify(await readE2EOpenClawState(electronApp))}`,
    ).toMatchObject({
      ok: true,
      data: {
        status: 202,
        ok: true,
        json: { outcome: 'queued', runId: expect.any(String) },
      },
    });

    const response = await invokeHostCapability(page, {
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey,
        sessionIdentity: identity,
        message: 'Read the fixed PNG attachment.',
        runId: `e2e-attachment-run-${crypto.randomUUID()}`,
        attachments: [attachment],
      },
    });

    expect(
      response,
      `Response: ${JSON.stringify(response)}; OpenClaw state: ${JSON.stringify(await readE2EOpenClawState(electronApp))}`,
    ).toMatchObject({
      ok: true,
      data: {
        status: 202,
        ok: true,
        json: { outcome: 'queued', runId: expect.any(String) },
      },
    });
    const projected = JSON.stringify(response);
    expect(projected).not.toContain('attachment-staging');
    expect(projected).not.toContain('media://');
    expect(projected).not.toContain(TINY_PNG_BASE64);
    expect(projected).not.toContain('iVBORw0KGgo');

    const secondUse = await invokeHostCapability(page, {
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey,
        sessionIdentity: identity,
        message: 'This must not replay the attachment.',
        runId: `e2e-attachment-replay-${crypto.randomUUID()}`,
        attachments: [attachment],
      },
    });
    expect(secondUse).toMatchObject({
      ok: true,
      data: { status: 500, ok: false, json: { success: false, error: 'Capability request failed' } },
    });
  });
});
