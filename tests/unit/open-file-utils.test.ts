import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('open file utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects direct-open fallback only for large pdf/excel files', async () => {
    const { shouldOfferDirectOpenFallback } = await import('@/components/file-preview/open-file-utils');

    expect(shouldOfferDirectOpenFallback('.pdf', 3 * 1024 * 1024)).toBe(true);
    expect(shouldOfferDirectOpenFallback('.xlsx', 3 * 1024 * 1024)).toBe(true);
    expect(shouldOfferDirectOpenFallback('.xls', 3 * 1024 * 1024)).toBe(true);
    expect(shouldOfferDirectOpenFallback('.md', 3 * 1024 * 1024)).toBe(false);
    expect(shouldOfferDirectOpenFallback('.pdf', 512 * 1024)).toBe(false);
  });

  it('opens paths externally and normalizes empty shell result to null', async () => {
    invokeIpcMock.mockResolvedValueOnce('');

    const { openArtifactPathExternally } = await import('@/components/file-preview/open-file-utils');
    const result = await openArtifactPathExternally('/workspace/report.pdf');

    expect(result).toBeNull();
    expect(invokeIpcMock).toHaveBeenCalledWith('shell:openPath', '/workspace/report.pdf');
  });

  it('reveals paths in file manager from structured shell result', async () => {
    invokeIpcMock.mockResolvedValueOnce({ success: true });

    const { revealArtifactPathInFileManager } = await import('@/components/file-preview/open-file-utils');
    const result = await revealArtifactPathInFileManager('/workspace/report.pdf');

    expect(result).toBe(true);
    expect(invokeIpcMock).toHaveBeenCalledWith('shell:showItemInFolder', '/workspace/report.pdf');
  });

  it('confirms before opening direct-open fallback files', async () => {
    invokeIpcMock
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce('');

    const { confirmAndOpenArtifactPath } = await import('@/components/file-preview/open-file-utils');
    const opened = await confirmAndOpenArtifactPath({
      filePath: '/workspace/report.pdf',
      fileName: 'report.pdf',
      size: 5 * 1024 * 1024,
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === 'artifacts.confirmOpenMessage') {
          return `open:${String(options?.fileName ?? '')}`;
        }
        if (key === 'artifacts.confirmOpenSize') {
          return `size:${String(options?.size ?? '')}`;
        }
        return key;
      },
    });

    expect(opened).toBe(true);
    expect(invokeIpcMock).toHaveBeenNthCalledWith(1, 'dialog:message', expect.objectContaining({
      title: 'artifacts.confirmOpenTitle',
      message: 'open:report.pdf',
      buttons: ['artifacts.confirmOpenCancel', 'artifacts.openDirectly'],
      detail: expect.stringContaining('/workspace/report.pdf'),
    }));
    expect(invokeIpcMock).toHaveBeenNthCalledWith(2, 'shell:openPath', '/workspace/report.pdf');
  });
});
