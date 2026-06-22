import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

const skillsStoreState: {
  skills: SkillMock[];
  snapshotReady: boolean;
  initialLoading: boolean;
  fetchSkills: () => Promise<void>;
} = {
  skills: [],
  snapshotReady: true,
  initialLoading: false,
  fetchSkills: vi.fn(async () => {}),
};

const testSessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'test-session',
};

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsStoreState) => unknown) => selector(skillsStoreState),
}));

describe('chat input quick phrases', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens an empty quick phrase dialog by default', () => {
    const { container } = render(<ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} />);

    fireEvent.click(screen.getByRole('button', { name: '快捷短语' }));

    const dialog = screen.getByRole('dialog', { name: '快捷短语' });
    expect(dialog).toBeInTheDocument();
    expect(container).not.toContainElement(dialog);
    expect(screen.getByText('还没有快捷短语，点“新增短语”添加常用内容。')).toBeInTheDocument();
    expect(screen.queryByText('截图一')).not.toBeInTheDocument();
  });

  it('adds a quick phrase and inserts the selected phrase', () => {
    render(<ChatInput onSend={vi.fn()} sessionIdentity={testSessionIdentity} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '请看', selectionStart: 2, selectionEnd: 2 } });

    fireEvent.click(screen.getByRole('button', { name: '快捷短语' }));
    fireEvent.click(screen.getByRole('button', { name: '新增短语' }));
    fireEvent.change(screen.getByLabelText('新增短语'), { target: { value: '截图四' } });
    fireEvent.click(screen.getByRole('button', { name: '添加短语' }));

    expect(screen.getByRole('dialog', { name: '快捷短语' })).toBeInTheDocument();
    expect(screen.getByText('截图四')).toBeInTheDocument();

    fireEvent.click(screen.getByText('截图四'));

    expect(textarea.value).toBe('请看 截图四');
    expect(screen.queryByRole('dialog', { name: '快捷短语' })).not.toBeInTheDocument();
  });
});
