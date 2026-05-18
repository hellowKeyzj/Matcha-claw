import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { UpdateNotifier } from '@/components/update/UpdateNotifier';
import { useUpdateStore } from '@/stores/update';
import { toast } from 'sonner';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => (
        options && typeof options.version === 'string'
          ? `${key}:${options.version}`
          : key
      ),
    }),
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    dismiss: vi.fn(),
  }),
}));

describe('UpdateNotifier', () => {
  beforeEach(() => {
    vi.mocked(toast).mockClear();
    vi.mocked(toast.dismiss).mockClear();
    useUpdateStore.setState({
      status: 'idle',
      currentVersion: '1.0.1',
      updateInfo: null,
      progress: null,
      error: null,
      isInitialized: true,
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installUpdate: vi.fn(),
    } as never);
  });

  it('prompts before downloading an available update', () => {
    const downloadUpdate = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({
      status: 'available',
      updateInfo: { version: '1.0.2' },
      downloadUpdate,
    } as never);

    render(<UpdateNotifier />);

    expect(toast).toHaveBeenCalledWith('updates.toast.availableTitle', expect.objectContaining({
      id: 'matchaclaw-update-available',
      description: 'updates.toast.availableDescription:1.0.2',
      duration: Infinity,
    }));

    const options = vi.mocked(toast).mock.calls[0]?.[1] as { action?: { onClick?: () => void } };
    act(() => {
      options.action?.onClick?.();
    });

    expect(toast.dismiss).toHaveBeenCalledWith('matchaclaw-update-available');
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('prompts before installing a downloaded update', () => {
    const installUpdate = vi.fn();
    useUpdateStore.setState({
      status: 'downloaded',
      updateInfo: { version: '1.0.2' },
      installUpdate,
    } as never);

    render(<UpdateNotifier />);

    expect(toast).toHaveBeenCalledWith('updates.toast.downloadedTitle', expect.objectContaining({
      id: 'matchaclaw-update-downloaded',
      description: 'updates.toast.downloadedDescription:1.0.2',
      duration: Infinity,
    }));

    const options = vi.mocked(toast).mock.calls[0]?.[1] as { action?: { onClick?: () => void } };
    act(() => {
      options.action?.onClick?.();
    });

    expect(toast.dismiss).toHaveBeenCalledWith('matchaclaw-update-downloaded');
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });
});
