import { describe, expect, it } from 'vitest';
import {
  createHistoryLoadAbortError,
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from '@/stores/chat/history-abort';

describe('chat history abort helpers', () => {
  it('creates abort-shaped error', () => {
    const error = createHistoryLoadAbortError('cancelled');
    expect(error.name).toBe('AbortError');
  });

  it('detects abort errors and ignores normal errors', () => {
    const abortError = createHistoryLoadAbortError();
    const normalError = new Error('regular failure');
    expect(isHistoryLoadAbortError(abortError)).toBe(true);
    expect(isHistoryLoadAbortError(normalError)).toBe(false);
  });

  it('throws when signal is already aborted', () => {
    const abortController = new AbortController();
    abortController.abort('done');
    expect(() => throwIfHistoryLoadAborted(abortController.signal)).toThrowError(/abort/i);
  });
});


