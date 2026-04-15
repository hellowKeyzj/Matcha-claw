import { describe, expect, it, vi } from 'vitest';
import { createChatStoreKernel } from '@/stores/chat/store-kernel';
import type { ChatStoreState } from '@/stores/chat/types';

type StoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

function createSetSpy() {
  const patches: Array<Partial<ChatStoreState>> = [];
  const set: StoreSetFn = ((partial) => {
    if (typeof partial === 'function') {
      return;
    }
    patches.push(partial);
  }) as StoreSetFn;
  return {
    set: vi.fn(set),
    readPatches: () => patches,
  };
}

describe('chat runtime store kernel', () => {
  it('toggles mutating only on counter edges', () => {
    const { set, readPatches } = createSetSpy();
    const kernel = createChatStoreKernel(set);

    kernel.beginMutating();
    kernel.beginMutating();
    kernel.finishMutating();
    kernel.finishMutating();

    expect(readPatches()).toEqual([
      { mutating: true },
      { mutating: false },
    ]);
  });

  it('ignores extra finishMutating calls after counter reaches zero', () => {
    const { set, readPatches } = createSetSpy();
    const kernel = createChatStoreKernel(set);

    kernel.finishMutating();
    kernel.beginMutating();
    kernel.finishMutating();
    kernel.finishMutating();

    expect(readPatches()).toEqual([
      { mutating: true },
      { mutating: false },
    ]);
  });

  it('keeps per-kernel isolated history runtime state', () => {
    const a = createChatStoreKernel(createSetSpy().set);
    const b = createChatStoreKernel(createSetSpy().set);

    expect(a.historyRuntime.getHistoryLoadRunId()).toBe(0);
    expect(b.historyRuntime.getHistoryLoadRunId()).toBe(0);

    expect(a.historyRuntime.nextHistoryLoadRunId()).toBe(1);
    expect(a.historyRuntime.nextHistoryLoadRunId()).toBe(2);
    expect(b.historyRuntime.nextHistoryLoadRunId()).toBe(1);

    a.historyRuntime.historyFingerprintBySession.set('session-a', 'fp-a');
    b.historyRuntime.historyFingerprintBySession.set('session-b', 'fp-b');

    expect(a.historyRuntime.historyFingerprintBySession.get('session-a')).toBe('fp-a');
    expect(a.historyRuntime.historyFingerprintBySession.get('session-b')).toBeUndefined();
    expect(b.historyRuntime.historyFingerprintBySession.get('session-b')).toBe('fp-b');
    expect(b.historyRuntime.historyFingerprintBySession.get('session-a')).toBeUndefined();
  });

  it('tracks per-session history abort controllers with replacement semantics', () => {
    const kernel = createChatStoreKernel(createSetSpy().set);
    const first = new AbortController();
    const second = new AbortController();

    expect(
      kernel.historyRuntime.replaceHistoryLoadAbortController('agent:main:main', first),
    ).toBeNull();
    expect(
      kernel.historyRuntime.replaceHistoryLoadAbortController('agent:main:main', second),
    ).toBe(first);

    // Stale controller clear should not remove the active one.
    kernel.historyRuntime.clearHistoryLoadAbortController('agent:main:main', first);
    expect(
      kernel.historyRuntime.replaceHistoryLoadAbortController('agent:main:main', first),
    ).toBe(second);
  });
});

