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
      'TOOLS.md': [
        { type: 'add', value: 'tools-line' },
      ],
    };

    render(<SubagentDiffPreview previewDiffByFile={previewDiffByFile} />);

    expect(screen.getByRole('button', { name: 'AGENTS.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TOOLS.md' })).toBeInTheDocument();

    expect(screen.getByText((content) => content.includes('agents-line'))).toBeInTheDocument();
    expect(screen.queryByText('tools-line')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'TOOLS.md' }));

    expect(screen.getByText((content) => content.includes('tools-line'))).toBeInTheDocument();
    expect(screen.queryByText('agents-line')).toBeNull();
  });
});
