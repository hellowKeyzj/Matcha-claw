import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('application boundary', () => {
  it('application layer does not import adapters', async () => {
    const files = [
      'electron/core/application/runtime-manager-service.ts',
      'electron/core/application/run-session-service.ts',
      'electron/core/application/tool-catalog-service.ts',
    ];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/adapters\//);
      expect(source).not.toMatch(/gateway\/manager/);
    }
  });
});
