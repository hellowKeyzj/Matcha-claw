import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

beforeEach(() => {
  window.electron.ipcRenderer.invoke = (...args: unknown[]) => invoke(...args);
});

afterEach(() => {
  invoke.mockReset();
});

describe('provider private mutation projection', () => {
  it('does not report an unknown delete outcome as success', async () => {
    invoke.mockResolvedValue({ status: 'unknown' });
    const { hostProviderDeleteAccount } = await import('@/lib/provider-projection');

    await expect(hostProviderDeleteAccount('openai-main', 1)).resolves.toEqual({
      success: false,
      error: 'Provider account request outcome is unknown',
    });
  });

  it('accepts only the expected durable success outcome', async () => {
    invoke.mockResolvedValue({
      status: 'deleted',
      receipt: {
        desired: { status: 'deleted' },
        persisted: { status: 'confirmed' },
        native: { changed: false, applied: { status: 'unknown' }, observed: { status: 'unavailable' } },
        commit: 'committed',
      },
    });
    const { hostProviderDeleteAccount } = await import('@/lib/provider-projection');

    await expect(hostProviderDeleteAccount('openai-main', 1)).resolves.toMatchObject({ success: true, receipt: { commit: 'committed' } });
  });
});
