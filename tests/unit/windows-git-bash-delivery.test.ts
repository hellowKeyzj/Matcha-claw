import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');

function readPackageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return packageJson.scripts;
}

describe('Windows Git Bash delivery', () => {
  it('prepares both pinned Git-for-Windows distributions before every Windows package command', () => {
    const scripts = readPackageScripts();

    expect(scripts['git-bash:download:win:x64']).toBe(
      'node scripts/download-bundled-git-bash.mjs --arch x64',
    );
    expect(scripts['git-bash:download:win:arm64']).toBe(
      'node scripts/download-bundled-git-bash.mjs --arch arm64',
    );
    expect(scripts['git-bash:download:win']).toBe(
      'pnpm run git-bash:download:win:x64 && pnpm run git-bash:download:win:arm64',
    );
    expect(scripts['prep:win-binaries']).toContain('pnpm run git-bash:download:win');
    expect(scripts['uv:download:win:x64']).toBe('zx scripts/download-bundled-uv.mjs --target=win32-x64');
    expect(scripts['bun:download:win:x64']).toBe('node scripts/download-bundled-bun.mjs --target=win32-x64');
    expect(scripts['node:download:win:x64']).toBe('zx scripts/download-bundled-node.mjs --target=win32-x64');
    expect(scripts['prep:win-x64-binaries']).toBe('pnpm run uv:download:win:x64 && pnpm run bun:download:win:x64 && pnpm run node:download:win:x64 && pnpm run git-bash:download:win:x64');
    expect(scripts['prep:win-x64-binaries:local-functional-bun-cache']).toBe('pnpm run uv:download:win:x64 && node scripts/download-bundled-bun.mjs --target=win32-x64 --reuse-functional-local-cache && pnpm run node:download:win:x64 && pnpm run git-bash:download:win:x64');
    expect(scripts['package:win:x64']).toContain('pnpm run prep:win-x64-binaries');
    expect(scripts['package:win:x64']).toContain('node scripts/run-electron-builder.mjs --win --x64');
    expect(scripts['prove:win:x64:package']).toBe('node scripts/prove-windows-x64-package.mjs');
    expect(scripts.package).toBe('pnpm run package:win');
    expect(scripts['package:win']).toContain('pnpm run prep:win-binaries');
    expect(scripts.release).toBe('pnpm run package:win -- --publish always');
  });

  it('packages the matching Windows Git Bash distribution into bin and targets x64 plus arm64', () => {
    const builder = parseYaml(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')) as {
      win: { extraResources: Array<{ from: string; to: string }>; target: Array<{ arch: string[] }> };
    };

    expect(builder.win.extraResources).toContainEqual({
      from: 'resources/bin/win32-${arch}',
      to: 'bin',
    });
    expect(builder.win.target).toContainEqual({ target: 'nsis', arch: ['x64', 'arm64'] });
  });

  it('ships the tracked Git-for-Windows redistribution notice through generic resources', () => {
    const builder = parseYaml(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')) as {
      extraResources: Array<{ from: string; to: string; filter: string[] }>;
    };

    expect(existsSync(resolve(root, 'resources', 'licenses', 'GIT_FOR_WINDOWS-2.55.0.3.txt'))).toBe(true);
    expect(builder.extraResources).toContainEqual({
      from: 'resources/',
      to: 'resources/',
      filter: ['**/*', '!icons/*.md', '!icons/*.svg', '!bin/**', '!screenshot/**'],
    });
  });
});
