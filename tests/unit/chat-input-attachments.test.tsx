import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '@/pages/Chat/ChatInput';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (typeof options?.count === 'number') {
        return `${key}:${String(options.count)}`;
      }
      return key;
    },
  }),
}));

const invokeIpcMock = vi.fn();

const testSessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'test-session',
};

const readySendGate = {
  canSend: true as const,
  kind: 'session' as const,
  sessionKey: testSessionIdentity.sessionKey,
  endpointSessionId: undefined,
  sessionIdentity: testSessionIdentity,
};

const readyNotesDialogAttachment = {
  stagedAttachmentId: 'staged-text',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  fileSize: 128,
  preview: null,
  sourcePath: 'D:\\docs\\notes.txt',
};


vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));


describe('chat input attachments', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
  });

  it('reconnecting 时在输入框上方显示轻量恢复提示并禁用输入', () => {
    render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} disabled reconnecting /></MemoryRouter>);

    expect(screen.getByText('input.gatewayRecoveringNotice')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('input.gatewayDisconnectedPlaceholder')).toBeDisabled();
  });

  it('图片附件以紧凑 chip 展示并支持点击预览', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return {
          canceled: false,
          attachments: [
            {
              stagedAttachmentId: 'staged-image',
              fileName: 'image.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
            },
          ],
        };
      }
      return null;
    });

    render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preview image\.png/i })).toBeInTheDocument();
    });

    expect(invokeIpcMock).toHaveBeenCalledWith('dialog:stageOpenAttachments', {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    expect(screen.queryByRole('img', { name: /image\.png/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview image\.png/i }));

    expect(screen.getByRole('dialog', { name: /image\.png/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /image\.png/i })).toBeInTheDocument();
  });

  it('paste/drag buffer attachments reject oversized files before reading base64', async () => {
    const onSend = vi.fn();
    render(<MemoryRouter><ChatInput onSend={onSend} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
    const input = screen.getByPlaceholderText('input.messagePlaceholder');
    const file = new File(['small'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 + 1 });

    fireEvent.paste(input, {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => file }],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('huge.bin')).toBeInTheDocument();
    });
    expect(invokeIpcMock).not.toHaveBeenCalledWith('dialog:stageRendererBufferAttachment', expect.anything());
    expect(screen.getByLabelText('Remove huge.bin')).toBeInTheDocument();
  });

  it('Electron File 拖放时经 buffer staging 并显示 ready 附件', async () => {
    const originalFileReader = globalThis.FileReader;
    const readAsDataUrl = vi.fn(function(this: FileReader) {
      Object.defineProperty(this, 'result', {
        configurable: true,
        value: 'data:text/plain;base64,ZXh0ZXJuYWwtY29udGVudA==',
      });
      this.onload?.(new ProgressEvent('load'));
    });
    class ControlledFileReader {
      result: string | ArrayBuffer | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      readAsDataURL = readAsDataUrl;
    }

    vi.stubGlobal('FileReader', ControlledFileReader);
    vi.mocked(window.electron.getPathForFile).mockReturnValue('D:\\external\\external.txt');
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:stageRendererBufferAttachment') {
        return {
          stagedAttachmentId: 'staged-external',
          fileName: 'external.txt',
          mimeType: 'text/plain',
          fileSize: 16,
          preview: null,
        };
      }
      return null;
    });

    try {
      render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
      const file = new File(['external-content'], 'external.txt', { type: 'text/plain' });

      fireEvent.drop(screen.getByPlaceholderText('input.messagePlaceholder').closest('.w-full')!, {
        dataTransfer: {
          files: [file],
          items: [{ kind: 'file', getAsFile: () => file }],
        },
      });

      await waitFor(() => {
        expect(window.electron.getPathForFile).toHaveBeenCalledWith(file);
        expect(invokeIpcMock).toHaveBeenCalledWith('dialog:stageRendererBufferAttachment', {
          base64: 'ZXh0ZXJuYWwtY29udGVudA==',
          fileName: 'external.txt',
          mimeType: 'text/plain',
        });
      });
        expect(screen.queryByRole('button', { name: 'Open external.txt' })).toBeNull();
    } finally {
      vi.stubGlobal('FileReader', originalFileReader);
    }
  });

  it('目录附件只作为 receipt 发送，不释放或传给 materialization', async () => {
    const directoryAttachment = {
      entryKind: 'directory' as const,
      fileName: 'project',
      mimeType: 'application/x-directory',
      fileSize: 0,
      preview: null,
      sourcePath: 'D:\\docs\\project',
    };
    const onSend = vi.fn().mockResolvedValue({ accepted: true });
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return {
          canceled: false,
          attachments: [directoryAttachment],
        };
      }
      return null;
    });

    render(<MemoryRouter><ChatInput onSend={onSend} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByText('project')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    const input = screen.getByPlaceholderText('input.messagePlaceholder');
    fireEvent.change(input, { target: { value: '打开这个目录' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('打开这个目录', [expect.objectContaining({
        stagedAttachmentId: expect.any(String),
        entryKind: 'directory',
        mimeType: 'application/x-directory',
        sourcePath: 'D:\\docs\\project',
      })]);
    });
    expect(invokeIpcMock).not.toHaveBeenCalledWith('dialog:releaseStagedAttachments', expect.anything());
  });

  it('普通文件附件在输入区仍不直接打开', async () => {
    invokeIpcMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return {
          canceled: false,
          attachments: [readyNotesDialogAttachment],
        };
      }
      return payload ?? null;
    });

    render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByText('notes.txt')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /open notes\.txt/i })).toBeNull();
    expect(invokeIpcMock).not.toHaveBeenCalledWith('shell:openPath', expect.anything());
  });

  it('attachment send rejection requires reselection and preserves the draft', async () => {
    const rejectedResult = {
      accepted: false,
      reason: 'error',
      error: 'Send failed',
      attachmentReselectionRequired: true,
    };
    const onSend = vi.fn().mockResolvedValue(rejectedResult);
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return {
          canceled: false,
          attachments: [readyNotesDialogAttachment],
        };
      }
      return null;
    });

    render(<MemoryRouter><ChatInput onSend={onSend} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByText('notes.txt')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('input.messagePlaceholder');
    const draft = '请保留这条待发送草稿';
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(draft, [
        {
          stagedAttachmentId: 'staged-text',
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          fileSize: 128,
          preview: null,
          sourcePath: 'D:\\docs\\notes.txt',
        },
      ]);
    });
    await expect(onSend.mock.results[0]?.value).resolves.toBe(rejectedResult);

    expect(input).toHaveValue(draft);
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(invokeIpcMock).toHaveBeenCalledWith('dialog:releaseStagedAttachments', ['staged-text']);
    expect(screen.queryByText('Select attachments again')).toBeNull();
    expect(screen.queryByRole('button', { name: /open notes\.txt/i })).toBeNull();
  });

  it('releases the removed staged attachment without blocking local cleanup', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return { canceled: false, attachments: [readyNotesDialogAttachment] };
      }
      if (channel === 'dialog:releaseStagedAttachments') {
        throw new Error('release unavailable');
      }
      return null;
    });

    render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Remove notes.txt'));

    await waitFor(() => {
      expect(screen.queryByText('notes.txt')).toBeNull();
      expect(invokeIpcMock).toHaveBeenCalledWith('dialog:releaseStagedAttachments', ['staged-text']);
    });
  });

  it('releases unconsumed staged attachments on unmount', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => (
      channel === 'dialog:stageOpenAttachments'
        ? { canceled: false, attachments: [readyNotesDialogAttachment] }
        : null
    ));

    const view = render(<MemoryRouter><ChatInput onSend={vi.fn()} sendGate={readySendGate} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    view.unmount();

    expect(invokeIpcMock).toHaveBeenCalledWith('dialog:releaseStagedAttachments', ['staged-text']);
  });
});
