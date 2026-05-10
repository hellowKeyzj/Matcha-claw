import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKED_ROOTS = ['electron', 'src'] as const;
const FORBIDDEN_RUNTIME_HOST_SEGMENTS = [
  'runtime-host/application/',
  'runtime-host/api/',
  'runtime-host/bootstrap/',
  'runtime-host/plugin-engine/',
] as const;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('runtime-host implementation boundary', () => {
  it('electron/src 不允许 import runtime-host 内部实现', async () => {
    const checkedFiles = (
      await Promise.all(CHECKED_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = (await readFile(file, 'utf8')).replace(/\\/g, '/');
      for (const segment of FORBIDDEN_RUNTIME_HOST_SEGMENTS) {
        if (source.includes(segment)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${segment}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
