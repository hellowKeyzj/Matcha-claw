import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCallDetail } from '@/types/call-log/provider';

const { invoke, waitForCall } = vi.hoisted(() => ({ invoke: vi.fn(), waitForCall: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ invokeIpc: invoke }));
vi.mock('@/lib/call-log-await', () => ({ waitForCall }));

const receipt = { callId: 'a'.repeat(32), accepted: true };

function terminal(detail: Partial<ProviderCallDetail>, status = 'unknown') {
  return {
    callId: receipt.callId,
    module: 'provider',
    command: 'providerAccounts.delete',
    status,
    detail: {
      kind: 'deleteAccount',
      phase: 'terminal',
      outcome: 'deleted',
      count: null,
      acceptedCount: null,
      persisted: 'confirmed',
      commit: 'committed',
      accountId: 'openai-main',
      accountRevision: 1,
      diagnostic: null,
      native: { changed: false, applied: 'unknown', observed: 'unavailable' },
      ...detail,
    },
  };
}

beforeEach(() => {
  invoke.mockResolvedValue(receipt);
});

afterEach(() => {
  invoke.mockReset();
  waitForCall.mockReset();
});

describe('provider private mutation projection', () => {
  it('does not report an unknown delete outcome as success', async () => {
    waitForCall.mockResolvedValue(terminal({ outcome: 'unknown', commit: 'unknown', persisted: 'unknown' }));
    const { hostProviderDeleteAccount } = await import('@/lib/provider-projection');

    await expect(hostProviderDeleteAccount('openai-main', 1)).resolves.toMatchObject({
      success: false,
      error: 'Provider account request outcome is unknown; reopen before retrying',
    });
    expect(waitForCall).toHaveBeenCalledWith(receipt, 'provider');
  });

  it('accepts only the expected durable success outcome', async () => {
    const { hostProviderDeleteAccount } = await import('@/lib/provider-projection');
    waitForCall.mockResolvedValue(terminal({ outcome: 'stored' }, 'succeeded'));
    await expect(hostProviderDeleteAccount('openai-main', 1)).resolves.toMatchObject({ success: false });

    waitForCall.mockResolvedValue(terminal({}));
    const result = await hostProviderDeleteAccount('openai-main', 1);
    expect(result).toMatchObject({ success: true, receipt: { commit: 'committed', persisted: 'confirmed' } });
    expect(result.warning).toBeTruthy();
    expect(result.receipt?.native).toEqual({ changed: false, applied: 'unknown', observed: 'unavailable' });
  });
});
