import { describe, expect, it } from 'vitest';
import { useChatView } from '@/pages/Chat/useChatView';

describe('chat view state', () => {
  it('derives blocking loading directly from session status and rows without delay retention', () => {
    const loading = useChatView({
      currentSessionKey: 'agent:main:main',
      currentSessionStatus: 'loading',
      itemCount: 0,
      runActive: false,
    });
    expect(loading.showBlockingLoading).toBe(true);
    expect(loading.isEmptyState).toBe(false);

    const ready = useChatView({
      currentSessionKey: 'agent:main:main',
      currentSessionStatus: 'ready',
      itemCount: 2,
      runActive: false,
    });
    expect(ready.showBlockingLoading).toBe(false);
  });

  it('shows empty state only for ready empty sessions', () => {
    const empty = useChatView({
      currentSessionKey: 'agent:main:main',
      currentSessionStatus: 'ready',
      itemCount: 0,
      runActive: false,
    });
    expect(empty.isEmptyState).toBe(true);
    expect(empty.showBlockingLoading).toBe(false);
  });

  it('没有选中会话时显示新会话空页而不是阻塞 loading', () => {
    const emptyDraft = useChatView({
      currentSessionKey: '',
      currentSessionStatus: 'idle',
      itemCount: 0,
      runActive: false,
    });

    expect(emptyDraft.isEmptyState).toBe(true);
    expect(emptyDraft.showBlockingLoading).toBe(false);
    expect(emptyDraft.showBlockingError).toBe(false);
  });

  it('shows blocking error only for empty error sessions', () => {
    const failed = useChatView({
      currentSessionKey: 'agent:main:main',
      currentSessionStatus: 'error',
      itemCount: 0,
      runActive: false,
    });

    expect(failed.showBlockingError).toBe(true);
    expect(failed.showBlockingLoading).toBe(false);
    expect(failed.isEmptyState).toBe(false);
  });
});
