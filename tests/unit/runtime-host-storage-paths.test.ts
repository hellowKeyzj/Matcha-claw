import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

describe('runtime-host storage paths', () => {
  it('开发态默认解析仓库根 node_modules/openclaw', async () => {
    const previousOpenClawDir = process.env.MATCHACLAW_OPENCLAW_DIR;
    try {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      const { getOpenClawDirPath } = await import('../../runtime-host/api/storage/paths');
      expect(getOpenClawDirPath()).toBe(resolve(join(process.cwd(), 'node_modules', 'openclaw')));
    } finally {
      if (previousOpenClawDir === undefined) {
        delete process.env.MATCHACLAW_OPENCLAW_DIR;
      } else {
        process.env.MATCHACLAW_OPENCLAW_DIR = previousOpenClawDir;
      }
    }
  });
});
