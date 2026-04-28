import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatViewportStage } from '@/pages/Chat/components/ChatViewportStage';

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
  ChatErrorBanner: () => <div data-testid="chat-error-banner" />,
}));

describe('chat viewport stage layout', () => {
  it('owns the header, viewport panel, runtime dock, and floating composer as one stage', () => {
    const { container } = render(
      <ChatViewportStage
        headerProps={{} as never}
        viewportPane={<div data-testid="thread-panel" />}
        errorBannerProps={{ error: 'boom', dismissLabel: 'dismiss', onDismiss: vi.fn() }}
        approvalDockProps={{ waitingLabel: 'waiting', approvals: [], onResolve: vi.fn() }}
        inputProps={{} as never}
      />,
    );

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('thread-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-stage-backdrop').className).toContain('absolute');
    expect(screen.getByTestId('chat-stage-backdrop').className).toContain('inset-0');
    expect(screen.getByTestId('chat-stage-header-overlay').className).toContain('absolute');
    expect(screen.getByTestId('chat-stage-header-overlay').className).toContain('top-0');
    expect(container.querySelector('[data-testid="chat-error-banner"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="chat-approval-dock"]')).toBeInTheDocument();

    const composerOverlay = screen.getByTestId('chat-input').parentElement?.parentElement?.parentElement as HTMLElement | null;
    expect(composerOverlay?.className).toContain('absolute');
    expect(composerOverlay?.className).toContain('bottom-0');
    expect(composerOverlay?.className).toContain('pointer-events-none');
  });
});
