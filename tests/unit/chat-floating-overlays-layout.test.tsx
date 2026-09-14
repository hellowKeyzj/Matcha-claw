import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatApprovalDock, ChatErrorBanner, ChatRuntimeStatusDock } from '@/pages/Chat/components/ChatRuntimeDock';
import { ChatImageLightbox } from '@/pages/Chat/components/ChatImageLightbox';
import type { ApprovalItem } from '@/stores/chat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'approval.pendingRequest' && typeof params?.title === 'string') {
        return params.title;
      }
      return {
        'approval.requestLabel': 'Tool needs approval',
        'approval.allowOnce': 'Allow once',
        'approval.allowAlways': 'Always allow',
        'approval.deny': 'Deny',
        'runtimeStatus.providerFallback': 'Provider fallback applied',
        'runtimeStatus.guardian.warning': 'Guardian warning',
      }[key] ?? key;
    },
  }),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

const approval: ApprovalItem = {
  id: 'approval-1',
  sessionKey: 'agent:main:main',
  sessionIdentity: {
    endpoint: {
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    },
    agentId: 'main',
    sessionKey: 'agent:main:main',
  },
  title: 'Approval required',
  command: 'pnpm test',
  allowedDecisions: ['deny', 'allow-once', 'allow-always'],
  createdAtMs: 1,
};

describe('chat floating overlays layout', () => {
  it('approval dock renders as a compact composer action bar', () => {
    const onResolve = vi.fn();
    const { container } = render(
      <ChatApprovalDock
        waitingLabel="waiting"
        approvals={[approval]}
        onResolve={onResolve}
      />,
    );

    const root = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('min-h-12');
    expect(root?.className).toContain('rounded-[18px]');
    expect(root?.className).toContain('bg-background/94');
    expect(root?.className).toContain('backdrop-blur-xl');
    expect(screen.getByText('Tool needs approval')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(onResolve).toHaveBeenCalledWith(approval, 'allow-once');
  });

  it('runtime error banner keeps the lighter floating surface language', () => {
    const { container } = render(
      <ChatErrorBanner
        error="boom"
        dismissLabel="dismiss"
        onDismiss={vi.fn()}
      />,
    );

    const root = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain('rounded-[22px]');
    expect(root?.className).toContain('bg-background/92');
    expect(root?.className).toContain('backdrop-blur-xl');
  });

  it('runtime status dock shows compaction state', () => {
    render(<ChatRuntimeStatusDock compacting errorDetail={null} />);

    expect(screen.getByTestId('chat-runtime-status-dock')).toBeInTheDocument();
    expect(screen.getByText('pending.compacting')).toBeInTheDocument();
  });

  it('runtime status dock shows safe fallback fields with provider preview text', () => {
    render(
      <ChatRuntimeStatusDock
        compacting={false}
        errorDetail={{
          failoverReason: 'rate_limit',
          providerRuntimeFailureKind: null,
          providerErrorType: 'overloaded',
          providerErrorMessagePreview: 'raw upstream text',
          httpStatus: 429,
        }}
      />,
    );

    expect(screen.getByText('Provider fallback applied')).toBeInTheDocument();
    expect(screen.getByText('rate_limit · overloaded · raw upstream text · HTTP 429')).toBeInTheDocument();
  });

  it('runtime status dock shows guardian notices', () => {
    render(
      <ChatRuntimeStatusDock
        compacting={false}
        errorDetail={null}
        runtimeNotice={{
          runId: 'run-1',
          kind: 'guardian_warning',
          command: null,
          riskLevel: 'medium',
          rationale: 'review required',
          message: null,
        }}
      />,
    );

    expect(screen.getByText('Guardian warning')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
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
});
