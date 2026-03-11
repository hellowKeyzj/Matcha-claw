import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';

type SkillMock = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  eligible?: boolean;
  icon?: string;
};

const fetchSkillsMock = vi.fn(async () => {});
const skillsStoreState: {
  skills: SkillMock[];
  loading: boolean;
  fetchSkills: () => Promise<void>;
} = {
  skills: [],
  loading: false,
  fetchSkills: fetchSkillsMock,
};

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsStoreState) => unknown) => selector(skillsStoreState),
}));

describe('chat input slash skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsStoreState.skills = [];
    skillsStoreState.loading = false;
  });

  it('slash 只展示可用技能（enabled 且 eligible=true）', () => {
    skillsStoreState.skills = [
      { id: 'task-manager', name: 'Task Manager', description: '', enabled: true, eligible: true, icon: '📌' },
      { id: 'missing-skill', name: 'Missing Skill', description: '', enabled: true, eligible: false, icon: '❌' },
      { id: 'disabled-skill', name: 'Disabled Skill', description: '', enabled: false, eligible: true, icon: '🚫' },
      { id: 'unknown-skill', name: 'Unknown Skill', description: '', enabled: true, icon: '❓' },
    ];

    render(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    expect(screen.getByRole('option', { name: /task manager/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /missing skill/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /disabled skill/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /unknown skill/i })).not.toBeInTheDocument();
  });

  it('slash 列表按上下键切换时会滚动到激活项', async () => {
    skillsStoreState.skills = [
      { id: 'skill-a', name: 'Skill A', description: '', enabled: true, eligible: true, icon: '🅰️' },
      { id: 'skill-b', name: 'Skill B', description: '', enabled: true, eligible: true, icon: '🅱️' },
      { id: 'skill-c', name: 'Skill C', description: '', enabled: true, eligible: true, icon: '🅲' },
    ];

    const scrollMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollMock,
    });

    render(<ChatInput onSend={vi.fn()} />);

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
});
