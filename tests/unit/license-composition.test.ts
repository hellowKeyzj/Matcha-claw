import { describe, expect, it, vi } from 'vitest';

const { nodeLicenseRuntimeMock, runtime } = vi.hoisted(() => {
  const gate = {
    state: 'blocked' as const,
    reason: 'no_stored_key',
    checkedAtMs: 1,
    hasStoredKey: false,
    hasUsableCache: false,
    nextRevalidateAtMs: null,
    lastValidation: null,
    renewalAlert: null,
  };
  const runtime = {
    gate: vi.fn(async () => gate),
    storedKey: vi.fn(async () => null),
    validate: vi.fn(async () => ({ valid: false as const, code: 'empty' as const, mode: 'none' as const })),
    revalidate: vi.fn(async () => ({ valid: false as const, code: 'empty' as const, mode: 'none' as const })),
    clear: vi.fn(async () => undefined),
  };
  return {
    nodeLicenseRuntimeMock: vi.fn(class MockNodeLicenseRuntime {
      constructor(_options: unknown) {
        return runtime;
      }
    }),
    runtime,
  };
});

vi.mock('../../electron/main/license/node-runtime', () => ({
  NodeLicenseRuntime: nodeLicenseRuntimeMock,
}));

import { composeLicenseService } from '../../electron/main/license/composition';

describe('License service composition', () => {
  it('composes the Electron-owned runtime without a Rust transport', async () => {
    const onGateChanged = vi.fn();
    const service = composeLicenseService({ onGateChanged });

    expect(nodeLicenseRuntimeMock).toHaveBeenCalledWith({ onGateChanged });
    await expect(service.gate()).resolves.toEqual({
      state: 'blocked',
      reason: 'no_stored_key',
      checkedAtMs: 1,
      hasStoredKey: false,
      hasUsableCache: false,
      nextRevalidateAtMs: null,
      lastValidation: null,
      renewalAlert: null,
    });
    await expect(service.storedKey()).resolves.toEqual({
      hasStoredKey: false,
      masked: null,
      last4: null,
    });
    await service.clear();
    expect(runtime.clear).toHaveBeenCalledOnce();
  });
});
