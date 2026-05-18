import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ExecutionGraphCard } from '@/pages/Chat/ExecutionGraphCard';
import type { SessionExecutionGraphStep } from '../../runtime-host/shared/session-adapter-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'executionGraph.agentRun') return `${String(options?.agent ?? '')} execution`;
      if (key === 'executionGraph.branchLabel') return '分支';
      if (key.startsWith('taskPanel.stepStatus.')) return key.split('.').at(-1) ?? key;
      return key;
    },
  }),
}));

function renderExecutionGraph(steps: SessionExecutionGraphStep[]) {
  return render(
    <ExecutionGraphCard
      agentLabel="main"
      sessionLabel="agent:main:subagent:session"
      steps={steps}
      active={false}
    />,
  );
}

describe('ExecutionGraphCard badge and subagent rows', () => {
  it('keeps status and branch badges on one line', () => {
    renderExecutionGraph([
      {
        id: 'tool-1',
        label: 'exec',
        kind: 'tool',
        status: 'error',
        depth: 2,
        detail: '{ "command": "openclaw gateway start" }',
      },
    ]);

    expect(screen.getByText('error').className).toContain('whitespace-nowrap');
    expect(screen.getByText('error').className).toContain('shrink-0');
    expect(screen.getByText('分支').className).toContain('whitespace-nowrap');
    expect(screen.getByText('分支').className).toContain('shrink-0');
  });

  it('renders system subagent roots as flat rows with an inline truncated session key', () => {
    const sessionKey = 'agent:main:subagent:08efe821-2717-4395-b3d7-a8f50928155f';
    const { container } = renderExecutionGraph([
      {
        id: 'child-root:session',
        label: 'main subagent',
        kind: 'system',
        status: 'completed',
        detail: sessionKey,
        depth: 1,
        parentId: 'agent-run',
      },
    ]);

    const stepRow = container.querySelector('[data-testid="chat-execution-step"]');
    const detailContainer = stepRow?.querySelector(':scope > div:last-child') as HTMLElement | null;
    expect(detailContainer?.className).toContain('px-0');
    expect(detailContainer?.className).not.toContain('rounded-[18px]');

    const preview = screen.getByText(sessionKey);
    expect(preview.tagName.toLowerCase()).toBe('p');
    expect(preview.className).toContain('truncate');
    expect(screen.queryByText('completed')).toBeNull();
  });

  it('expands long row details with word wrapping instead of breaking every character', () => {
    renderExecutionGraph([
      {
        id: 'child-root:session',
        label: 'main subagent',
        kind: 'system',
        status: 'completed',
        detail: 'agent:main:subagent:08efe821-2717-4395-b3d7-a8f50928155f',
        depth: 1,
        parentId: 'agent-run',
      },
    ]);

    fireEvent.click(screen.getByText('main subagent'));

    const details = document.querySelector('pre');
    expect(details?.className).toContain('break-words');
    expect(details?.className).not.toContain('break-all');
  });
});
