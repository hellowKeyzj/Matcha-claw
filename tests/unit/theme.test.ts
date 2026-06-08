import { describe, expect, it } from 'vitest';
import { applyResolvedTheme } from '@/lib/use-resolved-theme';

describe('theme application', () => {
  it('clears stale dark classes when applying light theme', () => {
    document.documentElement.classList.add('dark');
    document.body.classList.add('dark');

    applyResolvedTheme('light');

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
