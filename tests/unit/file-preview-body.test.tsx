import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilePreviewBody } from '@/components/file-preview/FilePreviewBody';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import type { SessionIdentity } from '../../runtime-host/shared/runtime-address';

const hostFileReadTextMock = vi.fn();
const hostFileReadBinaryMock = vi.fn();
const invokeIpcMock = vi.fn();
const confirmAndOpenArtifactPathMock = vi.fn();
const openArtifactPathExternallyMock = vi.fn();
const revealArtifactPathInFileManagerMock = vi.fn();
const createObjectUrlMock = vi.fn(() => 'blob:mock-image-url');
const revokeObjectUrlMock = vi.fn();
const NativeUrl = URL;
const sessionIdentity: SessionIdentity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'main',
  sessionKey: 'agent:main:main',
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
  hostFileReadText: (...args: unknown[]) => hostFileReadTextMock(...args),
  hostFileReadBinary: (...args: unknown[]) => hostFileReadBinaryMock(...args),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/components/file-preview/open-file-utils', () => ({
  shouldOfferDirectOpenFallback: (ext?: string | null, size?: number) => (
    !!ext && ['.pdf', '.xls', '.xlsx'].includes(ext.toLowerCase()) && typeof size === 'number' && size > 2 * 1024 * 1024
  ),
  confirmAndOpenArtifactPath: (...args: unknown[]) => confirmAndOpenArtifactPathMock(...args),
  openArtifactPathExternally: (...args: unknown[]) => openArtifactPathExternallyMock(...args),
  revealArtifactPathInFileManager: (...args: unknown[]) => revealArtifactPathInFileManagerMock(...args),
}));

vi.mock('@/components/file-preview/MonacoViewer', () => ({
  MonacoViewer: ({ value }: { value: string }) => <div data-testid="monaco-viewer">{value}</div>,
}));

vi.mock('@/components/file-preview/MonacoDiffViewer', () => ({
  MonacoDiffViewer: () => <div data-testid="monaco-diff-viewer" />,
}));

vi.mock('@/components/file-preview/MarkdownPreview', () => ({
  MarkdownPreview: ({ markdown }: { markdown: string }) => <div data-testid="markdown-preview">{markdown}</div>,
}));

vi.mock('@/components/file-preview/HtmlPreview', () => ({
  HtmlPreview: ({ source }: { source: string }) => <iframe data-testid="html-preview-frame" srcDoc={source} sandbox="allow-scripts allow-forms" />,
}));

vi.mock('@/components/file-preview/PdfViewer', () => ({
  PdfViewer: () => <div data-testid="pdf-viewer" />,
}));

vi.mock('@/components/file-preview/SheetViewer', () => ({
  SheetViewer: () => <div data-testid="sheet-viewer" />,
}));

describe('file preview body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', Object.assign(NativeUrl, {
      createObjectURL: createObjectUrlMock,
      revokeObjectURL: revokeObjectUrlMock,
    }));
    confirmAndOpenArtifactPathMock.mockResolvedValue(true);
    openArtifactPathExternallyMock.mockResolvedValue(null);
    revealArtifactPathInFileManagerMock.mockResolvedValue(true);
  });

  it('loads workspace code files from disk for preview instead of using empty inline content', async () => {
    hostFileReadTextMock.mockResolvedValue({
      ok: true,
      content: 'export const answer = 42;\n',
    });

    const file: ArtifactPreviewTarget = {
      filePath: '/workspace/demo.ts',
      fileName: 'demo.ts',
      ext: '.ts',
      mimeType: 'text/typescript',
      contentType: 'code',
      sourceTool: 'write',
      action: 'created',
      baseline: '',
      content: '',
      lineStats: { added: 0, removed: 0 },
      toolId: 'workspace:/workspace/demo.ts',
      sessionIdentity,
    };

    render(<FilePreviewBody file={file} mode="preview" />);

    await waitFor(() => {
      expect(hostFileReadTextMock).toHaveBeenCalledWith({ path: '/workspace/demo.ts', sessionIdentity });
    });
    expect(await screen.findByTestId('monaco-viewer')).toHaveTextContent('export const answer = 42;');
  });

  it('renders html files in a sandboxed iframe', async () => {
    hostFileReadTextMock.mockResolvedValue({
      ok: true,
      content: '<!doctype html><h1>Rendered Preview</h1>',
    });

    const file: ArtifactPreviewTarget = {
      filePath: '/workspace/demo.html',
      fileName: 'demo.html',
      ext: '.html',
      mimeType: 'text/html',
      contentType: 'html',
      sourceTool: 'write',
      action: 'created',
      baseline: '',
      content: '',
      lineStats: { added: 0, removed: 0 },
      toolId: 'workspace:/workspace/demo.html',
      sessionIdentity,
    };

    render(<FilePreviewBody file={file} mode="preview" />);

    await waitFor(() => {
      expect(hostFileReadTextMock).toHaveBeenCalledWith({ path: '/workspace/demo.html', sessionIdentity });
    });
    const frame = await screen.findByTestId('html-preview-frame');
    expect(frame).toHaveAttribute('srcdoc', '<!doctype html><h1>Rendered Preview</h1>');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  });

  it('renders image previews from binary file reads', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: true,
      data: 'aGVsbG8=',
      mimeType: 'image/png',
    });

    const file: ArtifactPreviewTarget = {
      filePath: '/workspace/demo.png',
      fileName: 'demo.png',
      ext: '.png',
      mimeType: 'image/png',
      contentType: 'image',
      sourceTool: 'write',
      action: 'created',
      baseline: '',
      content: '',
      lineStats: { added: 0, removed: 0 },
      toolId: 'workspace:/workspace/demo.png',
      sessionIdentity,
    };

    render(<FilePreviewBody file={file} mode="preview" />);

    await waitFor(() => {
      expect(hostFileReadBinaryMock).toHaveBeenCalledWith({ path: '/workspace/demo.png', sessionIdentity });
    });
    const image = await screen.findByRole('img', { name: 'demo.png' });
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(image).toHaveAttribute('src', 'blob:mock-image-url');
  });

  it('offers system open fallback for large preview targets', async () => {
    const file: ArtifactPreviewTarget = {
      filePath: '/workspace/report.pdf',
      fileName: 'report.pdf',
      ext: '.pdf',
      mimeType: 'application/pdf',
      contentType: 'pdf',
      sourceTool: 'write',
      action: 'created',
      baseline: '',
      content: '',
      lineStats: { added: 0, removed: 0 },
      toolId: 'workspace:/workspace/report.pdf',
      fileSize: 60 * 1024 * 1024,
    };

    render(<FilePreviewBody file={file} mode="preview" />);

    fireEvent.click(screen.getAllByRole('button', { name: 'artifacts.openDirectly' }).at(-1)!);
    fireEvent.click(screen.getAllByRole('button', { name: 'artifacts.reveal' }).at(-1)!);

    await waitFor(() => {
      expect(confirmAndOpenArtifactPathMock).toHaveBeenCalledWith(expect.objectContaining({
        filePath: '/workspace/report.pdf',
        fileName: 'report.pdf',
        size: 60 * 1024 * 1024,
      }));
    });
    expect(revealArtifactPathInFileManagerMock).toHaveBeenCalledWith('/workspace/report.pdf');
    expect(invokeIpcMock).not.toHaveBeenCalledWith('shell:openPath', '/workspace/report.pdf');
  });
});
