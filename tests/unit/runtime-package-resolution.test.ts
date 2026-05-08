import { describe, expect, it } from 'vitest';
import { resolveModulePathWithFallbacks } from '../../electron/utils/runtime-package-resolution';

describe('runtime package resolution', () => {
  it('returns the first resolver hit', () => {
    expect(resolveModulePathWithFallbacks('demo', [
      {
        label: 'primary',
        resolve: () => {
          throw new Error('miss');
        },
      },
      {
        label: 'fallback',
        resolve: (specifier) => `resolved:${specifier}`,
      },
    ])).toBe('resolved:demo');
  });

  it('includes each resolver failure in the final error', () => {
    expect(() => resolveModulePathWithFallbacks('demo', [
      {
        label: 'primary',
        resolve: () => {
          throw new Error('primary miss');
        },
      },
      {
        label: 'fallback',
        resolve: () => {
          throw new Error('fallback miss');
        },
      },
    ])).toThrow(
      'Failed to resolve "demo" from any runtime context. primary: primary miss | fallback: fallback miss',
    );
  });
});
