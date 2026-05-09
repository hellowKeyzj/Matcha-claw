import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SheetViewer } from '@/components/file-preview/SheetViewer';

const hostFileReadBinaryMock = vi.fn();
const xlsxReadMock = vi.fn();
const xlsxSheetToJsonMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'artifacts.previewUnnamedSheet') {
        return `Sheet ${String(options?.index ?? '')}`;
      }
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

vi.mock('xlsx', () => ({
  read: (...args: unknown[]) => xlsxReadMock(...args),
  utils: {
    sheet_to_json: (...args: unknown[]) => xlsxSheetToJsonMock(...args),
  },
}));

describe('sheet viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads workbook sheets and renders the selected sheet rows', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: true,
      data: 'aGVsbG8=',
    });
    xlsxReadMock.mockReturnValue({
      SheetNames: ['Summary', 'Raw'],
      Sheets: {
        Summary: { name: 'Summary' },
        Raw: { name: 'Raw' },
      },
    });
    xlsxSheetToJsonMock
      .mockReturnValueOnce([
        ['Name', 'Value'],
        ['Foo', 42],
      ])
      .mockReturnValueOnce([
        ['Raw'],
        ['A'],
      ]);

    render(<SheetViewer filePath="/workspace/demo.xlsx" />);

    await waitFor(() => {
      expect(hostFileReadBinaryMock).toHaveBeenCalledWith({
        path: '/workspace/demo.xlsx',
        maxBytes: 50 * 1024 * 1024,
      });
    });

    expect(await screen.findByRole('button', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Foo')).toBeInTheDocument();

    const rawButton = screen.getByRole('button', { name: 'Raw' });
    fireEvent.click(rawButton);
    await waitFor(() => {
      expect(rawButton.className).toContain('border-border/70');
    });
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('shows too-large state when workbook preview exceeds limits', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: false,
      error: 'tooLarge',
    });

    render(<SheetViewer filePath="/workspace/demo.xlsx" />);

    expect(await screen.findByText('artifacts.previewTooLarge')).toBeInTheDocument();
  });
});
