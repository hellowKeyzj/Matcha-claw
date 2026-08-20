import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const viteConfigPath = resolve(import.meta.dirname, '../../vite.config.ts');

describe('Vite build output ownership', () => {
  it('does not let the root config delete the shared Electron output tree at build start', () => {
    const source = readFileSync(viteConfigPath, 'utf8');

    expect(source).not.toMatch(/matchaclaw-clean-dist-electron/);
    expect(source).not.toMatch(/\brmSync\s*\(/);
    expect(source).not.toMatch(/buildStart\s*\([^)]*\)\s*\{[\s\S]*?dist-electron/);
  });
});
