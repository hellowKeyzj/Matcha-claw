import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PdfViewer } from '@/components/file-preview/PdfViewer';

const hostFileReadBinaryMock = vi.fn();

const sessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'openclaw:default',
  },
  agentId: 'files',
  sessionKey: 'files:test',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'artifacts.previewLoadFailed') {
        return `preview error: ${String(options?.error ?? '')}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/lib/host-api', () => ({
  hostFileReadBinary: (...args: unknown[]) => hostFileReadBinaryMock(...args),
}));

describe('pdf viewer', () => {
  const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads binary pdf data into an iframe preview', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: true,
      data: 'aGVsbG8=',
      mimeType: 'application/pdf',
    });

    render(<PdfViewer filePath="/workspace/demo.pdf" fileName="demo.pdf" sessionIdentity={sessionIdentity} />);

    await waitFor(() => {
      expect(hostFileReadBinaryMock).toHaveBeenCalledWith({
        path: '/workspace/demo.pdf',
        maxBytes: 50 * 1024 * 1024,
        sessionIdentity,
      });
    });

    const frame = await screen.findByTitle('demo.pdf');
    expect(frame).toHaveAttribute('src', 'blob:preview#toolbar=0&navpanes=0&scrollbar=1&view=FitH&zoom=page-width');
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });

  it('renders an error state when pdf loading fails', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: false,
      error: 'tooLarge',
    });

    render(<PdfViewer filePath="/workspace/demo.pdf" sessionIdentity={sessionIdentity} />);

    expect(await screen.findByText('artifacts.previewTooLarge')).toBeInTheDocument();
  });
});
