import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  eligible?: boolean;
  icon?: string;
};

const invokeIpcMock = vi.fn();
const hostApiFetchMock = vi.fn();
const fetchSkillsMock = vi.fn(async () => {});

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
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsStoreState) => unknown) => selector(skillsStoreState),
}));

describe('chat input attachments', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    hostApiFetchMock.mockReset();
    skillsStoreState.skills = [];
    skillsStoreState.snapshotReady = true;
    skillsStoreState.initialLoading = false;
  });

  it('图片附件以紧凑 chip 展示并支持点击预览', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:open') {
        return {
          canceled: false,
          filePaths: ['C:\\tmp\\image.png'],
        };
      }
      return null;
    });
    hostApiFetchMock.mockResolvedValueOnce([
      {
        id: 'staged-image',
        fileName: 'image.png',
        mimeType: 'image/png',
        fileSize: 1024,
        stagedPath: 'C:\\tmp\\image.png',
        preview: 'data:image/png;base64,abc',
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preview image\.png/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole('img', { name: /image\.png/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview image\.png/i }));

    expect(screen.getByRole('dialog', { name: /image\.png/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /image\.png/i })).toBeInTheDocument();
  });

  it('普通文件附件支持点击打开本地路径', async () => {
    invokeIpcMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'dialog:open') {
        return {
          canceled: false,
          filePaths: ['C:\\tmp\\notes.txt'],
        };
      }
      return payload ?? null;
    });
    hostApiFetchMock.mockResolvedValueOnce([
      {
        id: 'staged-text',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 128,
        stagedPath: 'C:\\tmp\\notes.txt',
        preview: null,
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open notes\.txt/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open notes\.txt/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith('shell:openPath', 'C:\\tmp\\notes.txt');
  });
});
