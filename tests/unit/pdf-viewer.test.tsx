import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FilePreviewBody } from '@/plugins/files/FilePreviewBody';
import { buildArtifactPreviewTargetFromPath } from '@/plugins/files/types';
import { createPluginHost } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { applicationShellPlugin } from '@/app/extensions';
import { filesPlugin } from '@/plugins/files/plugin';

const hostFileReadBinaryMock = vi.fn();
const createObjectURLMock = vi.fn(() => 'blob:preview');
const revokeObjectURLMock = vi.fn();

const agentScope = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'openclaw:default',
  },
  agentId: 'files',
};
const workspaceContext = { agentScope, workspaceRoot: '/workspace' };
const file = buildArtifactPreviewTargetFromPath('/workspace/docs/demo.pdf');
const pluginHost = createPluginHost([applicationShellPlugin, filesPlugin]);

function FilesPlugins({ children }: { children: ReactNode }) {
  return <PluginHostProvider host={pluginHost}>{children}</PluginHostProvider>;
}

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
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
  hostFileReadText: vi.fn(),
  hostFileReadBinary: (...args: unknown[]) => hostFileReadBinaryMock(...args),
}));

describe('pdf viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURLMock;
      static revokeObjectURL = revokeObjectURLMock;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads binary pdf data into an iframe preview', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: true,
      data: 'aGVsbG8=',
      mimeType: 'application/pdf',
    });

    render(<FilePreviewBody file={file} mode="preview" workspaceContext={workspaceContext} />, { wrapper: FilesPlugins });

    await waitFor(() => {
      expect(hostFileReadBinaryMock).toHaveBeenCalledWith({
        endpoint: agentScope.endpoint,
        agentId: agentScope.agentId,
        relativePath: 'docs/demo.pdf',
        maxBytes: 50 * 1024 * 1024,
      });
    });

    const frame = await screen.findByTitle('demo.pdf');
    expect(frame).toHaveAttribute('src', 'blob:preview#toolbar=0&navpanes=0&scrollbar=1&view=FitH&zoom=page-width');
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
  });

  it('renders an error state when pdf loading fails', async () => {
    hostFileReadBinaryMock.mockResolvedValue({
      ok: false,
      error: 'tooLarge',
    });

    render(<FilePreviewBody file={file} mode="preview" workspaceContext={workspaceContext} />, { wrapper: FilesPlugins });

    expect(await screen.findByText('artifacts.previewTooLarge')).toBeInTheDocument();
  });
});
