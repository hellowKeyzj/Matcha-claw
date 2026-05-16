import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalActionsPanel } from '@/pages/Chat/components/ChatStates';
import { ChatApprovalDock, ChatErrorBanner } from '@/pages/Chat/components/ChatRuntimeDock';
import { ChatImageLightbox } from '@/pages/Chat/components/ChatImageLightbox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      key === 'approval.pendingRequest' && typeof params?.title === 'string'
        ? params.title
        : key
    ),
  }),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

describe('chat floating overlays layout', () => {
  it('runtime dock uses the lighter floating surface language', () => {
    const { container, rerender } = render(
      <ChatApprovalDock
        waitingLabel="waiting"
        approvals={[]}
        onResolve={vi.fn()}
      />,
    );

    let root = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('rounded-[22px]');
    expect(root?.className).toContain('bg-background/92');
    expect(root?.className).toContain('backdrop-blur-xl');

    rerender(
      <ChatErrorBanner
        error="boom"
        dismissLabel="dismiss"
        onDismiss={vi.fn()}
      />,
    );

    root = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('rounded-[22px]');
    expect(root?.className).toContain('bg-background/92');
    expect(root?.className).toContain('backdrop-blur-xl');
  });

  it('image lightbox uses a soft backdrop and pill controls instead of hard utility chrome', () => {
    render(
      <ChatImageLightbox
        src="data:image/png;base64,abc"
        fileName="preview.png"
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'preview.png' });
    const overlay = dialog.parentElement as HTMLElement | null;
    expect(overlay?.className).toContain('bg-black/76');
    expect(overlay?.className).toContain('backdrop-blur-md');
    const controls = dialog.querySelector('div:last-child') as HTMLElement | null;
    expect(controls?.className).toContain('rounded-full');
    expect(controls?.className).toContain('backdrop-blur-xl');
  });

  it('approval panel renders request details and only allowed decisions', () => {
    render(
      <ApprovalActionsPanel
        approvals={[{
          id: 'approval-1',
          sessionKey: 'agent:main:main',
          title: 'gateway',
          command: 'Remove-Item demo.txt',
          allowedDecisions: ['allow-once', 'deny'],
          createdAtMs: 1,
        }]}
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByText('gateway')).toBeInTheDocument();
    expect(screen.getByText('Remove-Item demo.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.allowOnce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.deny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'approval.allowAlways' })).not.toBeInTheDocument();
  });
});
