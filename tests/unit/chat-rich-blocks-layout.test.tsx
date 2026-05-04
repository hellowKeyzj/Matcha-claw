import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StructuredTablePreview } from '@/pages/Chat/components/StructuredTablePreview';
import { CsvPreview } from '@/pages/Chat/components/CsvPreview';
import { ExecutionGraphCard } from '@/pages/Chat/ExecutionGraphCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'executionGraph.agentRun') {
        return `${String(options?.agent ?? '')} execution`;
      }
      return key;
    },
  }),
}));

describe('chat rich blocks layout', () => {
  it('structured table preview uses the lighter assistant reading surface', () => {
    const { container } = render(
      <StructuredTablePreview
        rows={[
          ['name', 'value'],
          ['alpha', '1'],
        ]}
        copyText={'name,value\nalpha,1'}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('rounded-[18px]');
    expect(root?.className).toContain('bg-background/68');
    expect(root?.className).toContain('backdrop-blur-sm');
  });

  it('csv preview fallback uses the same light surface instead of a heavy card shell', () => {
    const { container } = render(<CsvPreview csv={'"broken'} />);

    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('rounded-[18px]');
    expect(root?.className).toContain('bg-background/68');
    expect(root?.className).toContain('backdrop-blur-sm');
  });

  it('execution graph card stays inside the same light stage language', () => {
    const { container } = render(
      <ExecutionGraphCard
        agentLabel="Coder"
        sessionLabel="agent:coder:session-1"
        active
        steps={[
          {
            id: 'step-1',
            label: 'Thinking',
            status: 'running',
            kind: 'thinking',
            depth: 1,
            detail: 'reasoning',
          },
        ]}
        triggerItemKey="trigger-item"
        replyItemKey="reply-item"
        onJumpToItemKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-execution-graph').className).toContain('bg-background/62');
    const detailCard = container.querySelector('[data-testid="chat-execution-step"] > div:last-child') as HTMLElement | null;
    expect(detailCard?.className).toContain('rounded-[18px]');
    expect(detailCard?.className).toContain('bg-background/68');
  });
});
