import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { WorkspaceBrowserBody } from '@/components/file-preview/WorkspaceBrowserBody';
import type { SessionIdentity } from '../../runtime-host/shared/runtime-address';

const sessionIdentity: SessionIdentity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'test-session',
};

const hostFileListDirMock = vi.fn();
const openArtifactPathExternallyMock = vi.fn();
const revealArtifactPathInFileManagerMock = vi.fn();
const filePreviewBodyMock = vi.fn(({
  file,
  mode,
  headerAccessory,
}: {
  file: { fileName: string; filePath: string };
  mode: string;
  headerAccessory?: ReactNode;
}) => (
  <div data-testid="workspace-preview-body">
    <span>{file.fileName}</span>
    <span>{file.filePath}</span>
    <span>{mode}</span>
    <div>{headerAccessory}</div>
  </div>
));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'artifacts.workspaceLoadFailed') {
        return `workspace error: ${String(options?.error ?? '')}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/lib/host-api', () => ({
  hostFileListDir: (...args: unknown[]) => hostFileListDirMock(...args),
}));

vi.mock('@/components/file-preview/FilePreviewBody', () => ({
  FilePreviewBody: (props: unknown) => filePreviewBodyMock(props),
}));

vi.mock('@/components/file-preview/open-file-utils', () => ({
  openArtifactPathExternally: (...args: unknown[]) => openArtifactPathExternallyMock(...args),
  revealArtifactPathInFileManager: (...args: unknown[]) => revealArtifactPathInFileManagerMock(...args),
}));

describe('workspace browser body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openArtifactPathExternallyMock.mockResolvedValue(null);
    revealArtifactPathInFileManagerMock.mockResolvedValue(true);
  });

  it('loads the workspace root directory and previews the selected file in the right pane', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [
        {
          name: 'demo.ts',
          path: '/workspace/demo.ts',
          isDir: false,
          size: 0,
          mtimeMs: 0,
          hasChildren: false,
        },
      ],
    });
    const onSelectFile = vi.fn();

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath={null}
        selectedFile={null}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={onSelectFile}
      />,
    );

    await waitFor(() => {
      expect(hostFileListDirMock).toHaveBeenCalledWith(
        {
          path: '/workspace',
          sessionIdentity,
        },
        {
          timeoutMs: 60000,
        },
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: /demo\.ts/i }));
    expect(onSelectFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/workspace/demo.ts',
      fileName: 'demo.ts',
      contentType: 'code',
    }));
  });

  it('uses file row clicks only for preview focus', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [
        {
          name: 'demo.ts',
          path: '/workspace/demo.ts',
          isDir: false,
          size: 0,
          mtimeMs: 0,
          hasChildren: false,
        },
      ],
    });
    const onSelectFile = vi.fn();

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath={null}
        selectedFile={null}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={onSelectFile}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /demo\.ts/i }));
    expect(onSelectFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/workspace/demo.ts',
    }));
    expect(screen.queryByTestId('workspace-tree-select-toggle')).toBeNull();
  });

  it('renders the preview pane when a workspace file is already selected', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [],
    });

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath="/workspace/demo.ts"
        selectedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
        }}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={vi.fn()}
        onPreviewModeChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('workspace-preview-body')).toHaveTextContent('demo.ts');
    expect(screen.getByTestId('workspace-preview-body')).toHaveTextContent('/workspace/demo.ts');
    expect(screen.getByTestId('workspace-preview-body')).toHaveTextContent('preview');
    expect(screen.getByTestId('workspace-browser-body')).toHaveAttribute('data-layout', 'split');
    expect(screen.getByText('artifacts.workspaceTab')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-root-path')).toBeNull();
  });

  it('switches to a stacked workspace layout when the available width is narrow', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [],
    });

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath="/workspace/demo.ts"
        selectedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
        }}
        availableWidth={480}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('workspace-browser-body')).toHaveAttribute('data-layout', 'stacked');
    expect(screen.getByTestId('workspace-browser-body')).toHaveStyle({ gridTemplateRows: 'minmax(0, 320px) minmax(0,1fr)' });
  });

  it('keeps the provided workspace root visible while a file outside that root is focused elsewhere', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [],
    });

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath="~/.openclaw/skills/open-baidu/SKILL.md"
        selectedFile={{
          filePath: '~/.openclaw/skills/open-baidu/SKILL.md',
          fileName: 'SKILL.md',
          ext: '.md',
          mimeType: 'text/markdown',
          contentType: 'markdown',
        }}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={vi.fn()}
        onPreviewModeChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(hostFileListDirMock).toHaveBeenCalledWith(
        {
          path: '/workspace',
          sessionIdentity,
        },
        {
          timeoutMs: 60000,
        },
      );
    });
    expect(screen.queryByTestId('workspace-root-path')).toBeNull();
    expect(filePreviewBodyMock).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({
        filePath: '~/.openclaw/skills/open-baidu/SKILL.md',
        fileName: 'SKILL.md',
      }),
      mode: 'preview',
      headerAccessory: expect.anything(),
    }));
  });

  it('auto-expands parent directories by loading directory children incrementally', async () => {
    hostFileListDirMock
      .mockResolvedValueOnce({
        ok: true,
        entries: [
          {
            name: 'src',
            path: '/workspace/src',
            isDir: true,
            size: 0,
            mtimeMs: 0,
            hasChildren: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        entries: [
          {
            name: 'demo.ts',
            path: '/workspace/src/demo.ts',
            isDir: false,
            size: 0,
            mtimeMs: 0,
            hasChildren: false,
          },
        ],
      });

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath="/workspace/src/demo.ts"
        selectedFile={{
          filePath: '/workspace/src/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
        }}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: /demo\.ts/i })).toBeInTheDocument();
    expect(hostFileListDirMock).toHaveBeenNthCalledWith(
      2,
      {
        path: '/workspace/src',
        sessionIdentity,
      },
      {
        timeoutMs: 60000,
      },
    );
  });

  it('does not select a directory when toggling it open', async () => {
    hostFileListDirMock
      .mockResolvedValueOnce({
        ok: true,
        entries: [
          {
            name: 'memory',
            path: '/workspace/memory',
            isDir: true,
            size: 0,
            mtimeMs: 0,
            hasChildren: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        entries: [],
      });

    const onSelectFile = vi.fn();

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath={null}
        selectedFile={null}
        sessionIdentity={sessionIdentity}
        previewMode="preview"
        onSelectFile={onSelectFile}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /memory/i }));
    await waitFor(() => {
      expect(hostFileListDirMock).toHaveBeenNthCalledWith(
        2,
        {
          path: '/workspace/memory',
          sessionIdentity,
        },
        {
          timeoutMs: 60000,
        },
      );
    });
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it('keeps workspace diff mode available for a generated file selected from the tree', async () => {
    hostFileListDirMock.mockResolvedValue({
      ok: true,
      entries: [
        {
          name: 'demo.ts',
          path: '/workspace/demo.ts',
          isDir: false,
          size: 0,
          mtimeMs: 0,
          hasChildren: false,
        },
      ],
    });

    render(
      <WorkspaceBrowserBody
        rootPath="/workspace"
        selectedFilePath="/workspace/demo.ts"
        selectedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        sessionIdentity={sessionIdentity}
        previewMode="diff"
        onSelectFile={vi.fn()}
        onPreviewModeChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('workspace-preview-body')).toHaveTextContent('diff');
    expect(screen.queryByTestId('workspace-preview-mode-preview')).toBeNull();
    expect(screen.getByTestId('workspace-preview-mode-diff')).toHaveAttribute('aria-label', 'artifacts.previewTab');
  });
});
