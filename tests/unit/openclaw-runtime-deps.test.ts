import { describe, expect, it } from 'vitest';
import {
  EXTRA_OPENCLAW_RUNTIME_PACKAGES,
  mergeOpenClawRuntimePackages,
} from '../../scripts/openclaw-runtime-deps.mjs';

describe('openclaw runtime dependency bundle list', () => {
  it('includes packages resolved dynamically by bundled OpenClaw extensions', () => {
    expect(EXTRA_OPENCLAW_RUNTIME_PACKAGES).toEqual(expect.arrayContaining([
      'acpx',
      'playwright-core',
    ]));
  });

  it('merges staged extension deps with explicit runtime deps without duplicates', () => {
    expect(mergeOpenClawRuntimePackages(
      ['acpx', '@agentclientprotocol/sdk'],
      EXTRA_OPENCLAW_RUNTIME_PACKAGES,
      ['playwright-core'],
    )).toEqual([
      'acpx',
      '@agentclientprotocol/sdk',
      'playwright-core',
    ]);
  });
});
