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

type SkillMock = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  installed: boolean;
  eligible?: boolean;
  icon?: string;
};

const invokeIpcMock = vi.fn();
const hostFileStagePathsMock = vi.fn();
const hostFileStageBufferMock = vi.fn();
const fetchSkillsMock = vi.fn(async () => {});

const testSessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'test-session',
};

const readyNotesDialogAttachment = {
  id: 'staged-text',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  fileSize: 128,
  stagedPath: 'C:\\tmp\\notes.txt',
  preview: null,
};

const skillsStoreState: {
  skills: SkillMock[];
  snapshotReady: boolean;
  initialLoading: boolean;
  fetchSkills: () => Promise<void>;
} = {
  skills: [],
  snapshotReady: true,
  initialLoading: false,
  fetchSkills: fetchSkillsMock,
};

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostFileStagePaths: (...args: unknown[]) => hostFileStagePathsMock(...args),
  hostFileStageBuffer: (...args: unknown[]) => hostFileStageBufferMock(...args),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsStoreState) => unknown) => selector(skillsStoreState),
}));

describe('chat input attachments', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    hostFileStagePathsMock.mockReset();
    hostFileStageBufferMock.mockReset();
    skillsStoreState.skills = [];
    skillsStoreState.snapshotReady = true;
    skillsStoreState.initialLoading = false;
  });

  it('reconnecting 时在输入框上方显示轻量恢复提示并禁用输入', () => {
    render(<MemoryRouter><ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} disabled reconnecting /></MemoryRouter>);

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
              id: 'staged-image',
              fileName: 'image.png',
              mimeType: 'image/png',
              fileSize: 1024,
              stagedPath: 'C:\\tmp\\image.png',
              preview: 'data:image/png;base64,abc',
            },
          ],
        };
      }
      return null;
    });

    render(<MemoryRouter><ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preview image\.png/i })).toBeInTheDocument();
    });

    expect(invokeIpcMock).toHaveBeenCalledWith('dialog:stageOpenAttachments', {
      properties: ['openFile', 'multiSelections'],
    });
    expect(hostFileStagePathsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('img', { name: /image\.png/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview image\.png/i }));

    expect(screen.getByRole('dialog', { name: /image\.png/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /image\.png/i })).toBeInTheDocument();
  });

  it('paste/drag buffer attachments reject oversized files before reading base64', async () => {
    const onSend = vi.fn();
    render(<MemoryRouter><ChatInput onSend={onSend} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
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
    await waitFor(() => {
      expect(hostFileStageBufferMock).not.toHaveBeenCalled();
    });
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
    hostFileStageBufferMock.mockResolvedValue({
      id: 'staged-external',
      fileName: 'external.txt',
      mimeType: 'text/plain',
      fileSize: 16,
      stagedPath: 'C:\\tmp\\external.txt',
      preview: null,
    });

    try {
      render(<MemoryRouter><ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} /></MemoryRouter>);
      const file = new File(['external-content'], 'external.txt', { type: 'text/plain' });

      fireEvent.drop(screen.getByPlaceholderText('input.messagePlaceholder').closest('.w-full')!, {
        dataTransfer: {
          files: [file],
          items: [{ kind: 'file', getAsFile: () => file }],
        },
      });

      await waitFor(() => {
        expect(window.electron.getPathForFile).toHaveBeenCalledWith(file);
        expect(hostFileStageBufferMock).toHaveBeenCalledWith({
          base64: 'ZXh0ZXJuYWwtY29udGVudA==',
          fileName: 'external.txt',
          mimeType: 'text/plain',
          sessionIdentity: testSessionIdentity,
        });
      });
      expect(hostFileStagePathsMock).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Open external.txt' })).toBeInTheDocument();
    } finally {
      vi.stubGlobal('FileReader', originalFileReader);
    }
  });

  it('普通文件附件支持点击打开本地路径', async () => {
    invokeIpcMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'dialog:stageOpenAttachments') {
        return {
          canceled: false,
          attachments: [readyNotesDialogAttachment],
        };
      }
      return payload ?? null;
    });

    render(<MemoryRouter><ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open notes\.txt/i })).toBeInTheDocument();
    });

    expect(hostFileStagePathsMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /open notes\.txt/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:openPath', 'C:\\tmp\\notes.txt');
  });

  it('onSend 拒绝时保留草稿和 ready 附件', async () => {
    const rejectedResult = {
      accepted: false,
      reason: 'error',
      error: 'Send failed',
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

    render(<MemoryRouter><ChatInput onSend={onSend} sessionIdentity={testSessionIdentity} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open notes\.txt/i })).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('input.messagePlaceholder');
    const draft = '请保留这条待发送草稿';
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(draft, [
        { ...readyNotesDialogAttachment, status: 'ready' },
      ]);
    });
    await expect(onSend.mock.results[0]?.value).resolves.toBe(rejectedResult);

    expect(input).toHaveValue(draft);
    expect(screen.getByRole('button', { name: /open notes\.txt/i })).toBeInTheDocument();
  });
});
