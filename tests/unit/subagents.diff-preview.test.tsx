import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubagentDiffPreview } from '@/pages/SubAgents/components/SubagentDiffPreview';
import type { PreviewDiffByFile } from '@/types/subagent';

describe('subagents diff preview', () => {
  it('shows one file at a time and switches by file click', () => {
    const previewDiffByFile: PreviewDiffByFile = {
      'AGENTS.md': [
        { type: 'add', value: 'agents-line' },
      ],
      'MEMORY.md': [
        { type: 'add', value: 'memory-line' },
      ],
    };

    render(<SubagentDiffPreview previewDiffByFile={previewDiffByFile} />);

    expect(screen.getByRole('button', { name: 'AGENTS.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MEMORY.md' })).toBeInTheDocument();

    expect(screen.getByText((content) => content.includes('agents-line'))).toBeInTheDocument();
    expect(screen.queryByText('memory-line')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }));

    expect(screen.getByText((content) => content.includes('memory-line'))).toBeInTheDocument();
    expect(screen.queryByText('agents-line')).toBeNull();
  });
});
