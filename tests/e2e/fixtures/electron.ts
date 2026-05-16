import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
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

async function allocateFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate a free TCP port for Electron e2e');
  }

  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
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
    const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;

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

    const [hostApiPort, runtimeHostPort] = await Promise.all([
      allocateFreePort(),
      allocateFreePort(),
    ]);

    const launchEnv = {
      ...process.env,
      MATCHACLAW_E2E: '1',
      MATCHACLAW_E2E_USER_DATA_DIR: userDataDir,
      MATCHACLAW_PORT_MATCHACLAW_HOST_API: String(hostApiPort),
      MATCHACLAW_RUNTIME_HOST_PORT: String(runtimeHostPort),
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
    };
    delete launchEnv.ELECTRON_RUN_AS_NODE;

    try {
      const app = await electron.launch({
        args: [mainEntry],
        env: launchEnv,
      });

      await use(app);
      await app.close();
    } finally {
      if (previousElectronRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
      }
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
