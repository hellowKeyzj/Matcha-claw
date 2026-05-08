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
  eligible?: boolean;
  icon?: string;
  filePath?: string;
  baseDir?: string;
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

describe('chat skill preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsStoreState.skills = [
      {
        id: 'create-skill',
        name: 'Create Skill',
        description: 'Create and refine reusable skills.',
        enabled: true,
        eligible: true,
        icon: '🧩',
        filePath: '/tmp/workspace/skills/create-skill/SKILL.md',
        baseDir: '/tmp/workspace/skills/create-skill',
      },
    ];
    skillsStoreState.snapshotReady = true;
    skillsStoreState.initialLoading = false;
  });

  it('clicking selected skill chip triggers preview with skill metadata', () => {
    const onPreviewSkill = vi.fn();

    render(<ChatInput onSend={vi.fn()} onPreviewSkill={onPreviewSkill} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /create skill/i }));

    fireEvent.click(screen.getByTestId('chat-selected-skill-preview'));

    expect(onPreviewSkill).toHaveBeenCalledWith(expect.objectContaining({
      id: 'create-skill',
      name: 'Create Skill',
      filePath: '/tmp/workspace/skills/create-skill/SKILL.md',
      baseDir: '/tmp/workspace/skills/create-skill',
    }));
  });
});
