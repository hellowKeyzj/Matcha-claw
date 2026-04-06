import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('application boundary', () => {
  it('application layer does not import adapters', async () => {
    const files = [
      'runtime-host/application/platform-runtime/runtime-manager-service.ts',
      'runtime-host/application/platform-runtime/run-session-service.ts',
      'runtime-host/application/platform-runtime/tool-catalog-service.ts',
    ];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/adapters\//);
      expect(source).not.toMatch(/gateway\/manager/);
    }
  });
});
