import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatViewportStage } from '@/pages/Chat/components/ChatViewportStage';

describe('chat viewport stage layout', () => {
  it('owns the header, viewport panel, runtime dock, and floating composer as one stage', () => {
    const { container } = render(
      <ChatViewportStage
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={<div data-testid="chat-error-banner" />}
        approvalDock={<div data-testid="chat-approval-dock" />}
        input={<div data-testid="chat-input" />}
      />,
    );

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('thread-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-stage-backdrop').className).toContain('absolute');
    expect(screen.getByTestId('chat-stage-backdrop').className).toContain('inset-0');
    expect(screen.getByTestId('chat-stage-header-overlay').className).toContain('absolute');
    expect(screen.getByTestId('chat-stage-header-overlay').className).toContain('top-0');
    expect(screen.getByTestId('chat-stage-bottom-fade').className).toContain('absolute');
    expect(screen.getByTestId('chat-stage-bottom-fade').className).toContain('bottom-0');
    expect(screen.getByTestId('chat-stage-bottom-fade').className).toContain('right-[var(--chat-scrollbar-gutter)]');
    expect(container.querySelector('[data-testid="chat-error-banner"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="chat-approval-dock"]')).toBeInTheDocument();

    const composerOverlay = screen.getByTestId('chat-input').parentElement?.parentElement?.parentElement as HTMLElement | null;
    expect(composerOverlay?.className).toContain('absolute');
    expect(composerOverlay?.className).toContain('bottom-0');
    expect(composerOverlay?.className).toContain('pointer-events-none');
  });
});
