import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubagentFilesPreview } from '@/pages/SubAgents/components/SubagentFilesPreview';
import type { SubagentTargetFile } from '@/types/subagent';

describe('subagents files preview', () => {
  it('shows one file at a time and switches by file click', () => {
    const persistedContentByFile: Partial<Record<SubagentTargetFile, string>> = {
      'AGENTS.md': 'agents-line',
      'MEMORY.md': 'memory-line',
    };

    render(<SubagentFilesPreview persistedContentByFile={persistedContentByFile} />);

    expect(screen.getByRole('button', { name: 'AGENTS.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MEMORY.md' })).toBeInTheDocument();

    expect(screen.getByText((content) => content.includes('agents-line'))).toBeInTheDocument();
    expect(screen.queryByText('memory-line')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }));

    expect(screen.getByText((content) => content.includes('memory-line'))).toBeInTheDocument();
    expect(screen.queryByText('agents-line')).toBeNull();
  });
});
