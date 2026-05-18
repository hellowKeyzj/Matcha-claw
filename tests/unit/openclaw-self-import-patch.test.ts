import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  patchExtensionOpenClawSelfImports,
  rewriteOpenClawPluginSdkSpecifiers,
  toImportSpecifier,
} from '../../scripts/openclaw-self-import-patch.mjs';

const tempRoots: string[] = [];

async function createTempOpenClawBundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'matchaclaw-openclaw-self-import-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('openclaw self-import bundle patch', () => {
  it('converts OpenClaw plugin-sdk package specifiers to bundled relative paths', async () => {
    const root = await createTempOpenClawBundle();
    const distDir = path.join(root, 'dist');
    const pluginSdkDir = path.join(distDir, 'plugin-sdk');
    const extensionDir = path.join(distDir, 'extensions', 'codex');
    await mkdir(pluginSdkDir, { recursive: true });
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(pluginSdkDir, 'provider-model-shared.js'), 'export const ok = true;\n');

    const extensionFile = path.join(extensionDir, 'prompt-overlay.js');
    await writeFile(
      extensionFile,
      [
        'import { ok } from "openclaw/plugin-sdk/provider-model-shared";',
        'export { ok };',
        '',
      ].join('\n'),
    );

    const result = patchExtensionOpenClawSelfImports(root);

    expect(result).toMatchObject({
      filesPatched: 1,
      specifiersPatched: 1,
    });
    await expect(readFile(extensionFile, 'utf8')).resolves.toContain(
      'from "../../plugin-sdk/provider-model-shared.js"',
    );
  });

  it('leaves extension files without OpenClaw self-imports untouched', async () => {
    const root = await createTempOpenClawBundle();
    const extensionDir = path.join(root, 'dist', 'extensions', 'telegram');
    await mkdir(extensionDir, { recursive: true });

    const extensionFile = path.join(extensionDir, 'index.js');
    const original = 'export const ok = true;\n';
    await writeFile(extensionFile, original);

    const result = patchExtensionOpenClawSelfImports(root);

    expect(result.filesPatched).toBe(0);
    await expect(readFile(extensionFile, 'utf8')).resolves.toBe(original);
  });

  it('rejects unsafe plugin-sdk subpaths', () => {
    expect(() => rewriteOpenClawPluginSdkSpecifiers(
      'import x from "openclaw/plugin-sdk/../secret";',
      {
        filePath: path.join('dist', 'extensions', 'bad', 'index.js'),
        distDir: 'dist',
      },
    )).toThrow(/Invalid OpenClaw plugin-sdk import subpath/);
  });

  it('requires the bundled plugin-sdk target to exist before rewriting', () => {
    const root = path.join(tmpdir(), 'matchaclaw-openclaw-self-import-missing');
    expect(existsSync(root)).toBe(false);
    expect(() => rewriteOpenClawPluginSdkSpecifiers(
      'import x from "openclaw/plugin-sdk/missing";',
      {
        filePath: path.join(root, 'dist', 'extensions', 'bad', 'index.js'),
        distDir: path.join(root, 'dist'),
      },
    )).toThrow(/missing bundled SDK target/);
  });

  it('normalizes relative import specifiers to ESM form', () => {
    expect(toImportSpecifier(path.join('..', '..', 'plugin-sdk', 'tool.js'))).toBe('../../plugin-sdk/tool.js');
    expect(toImportSpecifier('plugin-sdk/tool.js')).toBe('./plugin-sdk/tool.js');
  });
});
