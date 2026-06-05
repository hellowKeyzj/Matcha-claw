import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { OpenClawCliCommandWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow';
import type { RuntimePlatform } from '../../runtime-host/application/common/runtime-ports';

function createWorkflow(input: {
  platform?: RuntimePlatform;
  packageExists?: boolean;
  entryExists?: boolean;
  binExists?: boolean;
}) {
  const openclawDir = '/workspace/node_modules/openclaw';
  const entryPath = join(openclawDir, 'openclaw.mjs');
  const binPath = join('/workspace/node_modules', '.bin', input.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  return new OpenClawCliCommandWorkflow({
    environment: {
      getOpenClawStatus: async () => ({
        packageExists: input.packageExists ?? true,
        isBuilt: true,
        entryPath,
        dir: openclawDir,
      }),
      getPlatform: () => input.platform ?? 'linux',
      pathExists: async (pathname) => {
        if (pathname === entryPath) return input.entryExists ?? true;
        if (pathname === binPath) return input.binExists ?? false;
        return false;
      },
    },
  });
}

describe('OpenClawCliCommandWorkflow', () => {
  it('returns an error when the OpenClaw package is missing', async () => {
    await expect(createWorkflow({ packageExists: false }).cliCommand()).resolves.toEqual({
      success: false,
      error: 'OpenClaw package not found at: /workspace/node_modules/openclaw',
    });
  });

  it('returns an error when the entry script is missing', async () => {
    await expect(createWorkflow({ entryExists: false }).cliCommand()).resolves.toEqual({
      success: false,
      error: `OpenClaw entry script not found at: ${join('/workspace/node_modules/openclaw', 'openclaw.mjs')}`,
    });
  });

  it('prefers the package bin when present', async () => {
    await expect(createWorkflow({ binExists: true }).cliCommand()).resolves.toEqual({
      success: true,
      command: `"${join('/workspace/node_modules', '.bin', 'openclaw')}"`,
    });
  });

  it('falls back to node entry command on Windows', async () => {
    await expect(createWorkflow({ platform: 'win32' }).cliCommand()).resolves.toEqual({
      success: true,
      command: `node '${join('/workspace/node_modules/openclaw', 'openclaw.mjs')}'`,
    });
  });
});
