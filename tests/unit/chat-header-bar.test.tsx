import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatHeaderBar } from '@/pages/Chat/components/ChatHeaderBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({
    children,
    side,
    align,
  }: {
    children: React.ReactNode;
    side?: string;
    align?: string;
  }) => (
    <div data-testid="tooltip-content" data-side={side} data-align={align}>
      {children}
    </div>
  ),
}));

describe('chat header bar task panel toggle', () => {
  it('shows unfinished task count and uses header buttons for export and the shared side panel', () => {
    const onExportMarkdown = vi.fn();
    const onToggleSidePanel = vi.fn();

    render(
      <ChatHeaderBar
        onRefresh={vi.fn()}
        refreshBusy={false}
        showThinking={false}
        onToggleThinking={vi.fn()}
        onExportMarkdown={onExportMarkdown}
        sidePanelOpen={false}
        unfinishedTaskCount={7}
        onToggleSidePanel={onToggleSidePanel}
      />,
    );

    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getAllByTestId('tooltip-content')).toHaveLength(4);
    for (const tooltip of screen.getAllByTestId('tooltip-content')) {
      expect(tooltip).toHaveAttribute('data-side', 'bottom');
      expect(tooltip).toHaveAttribute('data-align', 'end');
    }
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.exportMarkdown' }));
    expect(onExportMarkdown).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.openSidePanel' }));
    expect(onToggleSidePanel).toHaveBeenCalledTimes(1);
  });
});
