import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

describe('E2E fixture loader', () => {
  it('does not replace sealed Electron and Rust delivery boundaries', async () => {
    const loader = await import('../../electron/main/e2e-fixture-loader');

    await expect(loader.handleE2EHostApiFetch({
      method: 'POST',
      path: '/api/files/read-text',
      body: { privatePath: 'C:\\private' },
    })).resolves.toBeNull();
    await expect(loader.getE2EDialogOpenResult()).resolves.toBeNull();
    await expect(loader.getE2EDialogStagedAttachments()).resolves.toBeNull();
    await expect(loader.getE2EGatewayStatus()).resolves.toBeNull();
  });
});
