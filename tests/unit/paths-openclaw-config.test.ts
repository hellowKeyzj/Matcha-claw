import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const originalE2EMode = process.env.MATCHACLAW_E2E;
const originalE2EUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR;
const originalOpenClawConfigDir = process.env.OPENCLAW_CONFIG_DIR;

afterEach(() => {
  if (originalE2EMode === undefined) delete process.env.MATCHACLAW_E2E;
  else process.env.MATCHACLAW_E2E = originalE2EMode;
  if (originalE2EUserDataDir === undefined) delete process.env.MATCHACLAW_E2E_USER_DATA_DIR;
  else process.env.MATCHACLAW_E2E_USER_DATA_DIR = originalE2EUserDataDir;
  if (originalOpenClawConfigDir === undefined) delete process.env.OPENCLAW_CONFIG_DIR;
  else process.env.OPENCLAW_CONFIG_DIR = originalOpenClawConfigDir;
  vi.resetModules();
});

describe('getOpenClawConfigDir', () => {
  it('uses OPENCLAW_CONFIG_DIR when configured', async () => {
    process.env.OPENCLAW_CONFIG_DIR = '~/.openclaw-legacy';
    const { getOpenClawConfigDir } = await import('../../electron/utils/paths');

    expect(getOpenClawConfigDir()).toBe(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.openclaw-legacy'));
  });

  it('uses the isolated E2E state root only in E2E mode', async () => {
    delete process.env.OPENCLAW_CONFIG_DIR;
    process.env.MATCHACLAW_E2E = '1';
    process.env.MATCHACLAW_E2E_USER_DATA_DIR = 'E:\\temp\\matchaclaw-e2e';
    const { getOpenClawConfigDir } = await import('../../electron/utils/paths');

    expect(getOpenClawConfigDir()).toBe(join('E:\\temp\\matchaclaw-e2e', 'openclaw'));
  });

  it('uses the legacy home state root outside E2E mode', async () => {
    delete process.env.MATCHACLAW_E2E;
    process.env.MATCHACLAW_E2E_USER_DATA_DIR = 'E:\\temp\\matchaclaw-e2e';
    const { getOpenClawConfigDir } = await import('../../electron/utils/paths');

    expect(getOpenClawConfigDir()).toBe(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.openclaw'));
  });
});
