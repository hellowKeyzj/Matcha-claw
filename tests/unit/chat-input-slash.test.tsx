import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
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

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsStoreState) => unknown) => selector(skillsStoreState),
}));

function renderWithRouter(element: ReactElement) {
  return render(
    <MemoryRouter>
      {element}
    </MemoryRouter>,
  );
}

describe('chat input slash skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsStoreState.skills = [];
    skillsStoreState.snapshotReady = true;
    skillsStoreState.initialLoading = false;
  });

  it('slash 只展示可用技能（enabled 且 eligible=true）', () => {
    skillsStoreState.skills = [
      { id: 'task-manager', name: 'Task Manager', description: '', enabled: true, installed: true, eligible: true, icon: '📌' },
      { id: 'missing-skill', name: 'Missing Skill', description: '', enabled: true, installed: true, eligible: false, icon: '❌' },
      { id: 'disabled-skill', name: 'Disabled Skill', description: '', enabled: false, installed: true, eligible: true, icon: '🚫' },
      { id: 'unknown-skill', name: 'Unknown Skill', description: '', enabled: true, installed: true, icon: '❓' },
    ];

    renderWithRouter(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    expect(screen.getByRole('option', { name: /task manager/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /missing skill/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /disabled skill/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /unknown skill/i })).not.toBeInTheDocument();
  });

  it('slash 支持按当前会话 agent 的技能白名单过滤', () => {
    skillsStoreState.skills = [
      { id: 'web-search', name: 'Web Search', description: '', enabled: true, installed: true, eligible: true, icon: '🌐' },
      { id: 'feishu-doc', name: 'Feishu Doc', description: '', enabled: true, installed: true, eligible: true, icon: '📄' },
    ];

    renderWithRouter(<ChatInput onSend={vi.fn()} allowedSkillIds={['feishu-doc']} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    expect(screen.getByRole('option', { name: /feishu doc/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /web search/i })).not.toBeInTheDocument();
  });

  it('slash 列表按上下键切换时会滚动到激活项', async () => {
    skillsStoreState.skills = [
      { id: 'skill-a', name: 'Skill A', description: '', enabled: true, installed: true, eligible: true, icon: '🅰️' },
      { id: 'skill-b', name: 'Skill B', description: '', enabled: true, installed: true, eligible: true, icon: '🅱️' },
      { id: 'skill-c', name: 'Skill C', description: '', enabled: true, installed: true, eligible: true, icon: '🅲' },
    ];

    const scrollMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollMock,
    });

    renderWithRouter(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });

    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options[2]).toHaveAttribute('aria-selected', 'true');
    });

    expect(scrollMock).toHaveBeenCalled();
  });

  it('renders model picker and forwards selection', () => {
    const onSelect = vi.fn();

    renderWithRouter(
      <ChatInput
        onSend={vi.fn()}
        modelPicker={{
          currentModelId: 'openai/gpt-5.4',
          currentLabel: 'OpenAI / gpt-5.4',
          options: [
            { id: 'openai/gpt-5.4', label: 'OpenAI / gpt-5.4' },
            { id: 'anthropic/claude-opus-4-6', label: 'Anthropic / claude-opus-4-6' },
          ],
          loading: false,
          switching: false,
          onSelect,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('chat-model-picker'));
    fireEvent.click(screen.getByRole('option', { name: /Anthropic \/ claude-opus-4-6/i }));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-opus-4-6');
  });
});
