import { describe, expect, it } from 'vitest';
import { useChatView } from '@/pages/Chat/useChatView';

describe('chat view state', () => {
  it('derives blocking loading directly from session status and rows without delay retention', () => {
    const loading = useChatView({
      currentSessionStatus: 'loading',
      itemCount: 0,
    });
    expect(loading.showBlockingLoading).toBe(true);
    expect(loading.isEmptyState).toBe(false);

    const ready = useChatView({
      currentSessionStatus: 'ready',
      itemCount: 2,
    });
    expect(ready.showBlockingLoading).toBe(false);
  });

  it('shows empty state only for ready empty sessions', () => {
    const empty = useChatView({
      currentSessionStatus: 'ready',
      itemCount: 0,
    });
    expect(empty.isEmptyState).toBe(true);
    expect(empty.showBlockingLoading).toBe(false);
  });

  it('shows blocking error only for empty error sessions', () => {
    const failed = useChatView({
      currentSessionStatus: 'error',
      itemCount: 0,
    });

    expect(failed.showBlockingError).toBe(true);
    expect(failed.showBlockingLoading).toBe(false);
    expect(failed.isEmptyState).toBe(false);
  });
});
