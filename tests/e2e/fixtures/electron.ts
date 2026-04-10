import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  homeDir: string;
};

async function waitForPrimaryWindow(
  electronApp: ElectronApplication,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = electronApp.windows().filter((window) => !window.isClosed());
    if (windows.length > 0) {
      return windows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Electron window after ${timeoutMs}ms`);
}

async function ensurePathExists(path: string): Promise<void> {
  await access(path, fsConstants.F_OK);
}

export const test = base.extend<ElectronFixtures>({
  homeDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'matchaclaw-e2e-home-'));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  electronApp: async ({ homeDir }, use) => {
    const userDataDir = join(homeDir, 'user-data');
    const appDataDir = join(homeDir, 'AppData', 'Roaming');
    const localAppDataDir = join(homeDir, 'AppData', 'Local');
    await mkdir(userDataDir, { recursive: true });
    await mkdir(appDataDir, { recursive: true });
    await mkdir(localAppDataDir, { recursive: true });
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ setupComplete: true }, null, 2),
      'utf8',
    );

    const mainEntry = join(process.cwd(), 'dist-electron', 'main', 'index.js');
    const preloadEntry = join(process.cwd(), 'dist-electron', 'preload', 'index.js');
    const rendererIndex = join(process.cwd(), 'dist', 'index.html');
    await ensurePathExists(mainEntry);
    await ensurePathExists(preloadEntry);
    await ensurePathExists(rendererIndex);

    const launchEnv = {
      ...process.env,
      CLAWX_E2E: '1',
      CLAWX_E2E_USER_DATA_DIR: userDataDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
    };
    delete launchEnv.ELECTRON_RUN_AS_NODE;

    const app = await electron.launch({
      args: [mainEntry],
      env: launchEnv,
    });

    try {
      await use(app);
    } finally {
      await app.close();
    }
  },

  page: async ({ electronApp }, use) => {
    const page = await waitForPrimaryWindow(electronApp);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
    await use(page);
  },
});

export { expect };
