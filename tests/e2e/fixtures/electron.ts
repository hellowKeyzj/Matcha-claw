import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  homeDir: string;
  profileDir: string;
};

function reusableProfileDir(): string | null {
  const configured = process.env.MATCHACLAW_E2E_PROFILE_DIR?.trim();
  if (!configured) {
    return null;
  }
  if (!isAbsolute(configured)) {
    throw new Error('MATCHACLAW_E2E_PROFILE_DIR must be an absolute path');
  }
  return configured;
}

function explicitUserDataDir(): string | null {
  const configured = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  if (!configured) {
    return null;
  }
  if (!isAbsolute(configured)) {
    throw new Error('MATCHACLAW_E2E_USER_DATA_DIR must be an absolute path');
  }
  return configured;
}

const portKeys = [
  'MATCHACLAW_DIAGNOSTICS_TRANSPORT',
  'MATCHACLAW_WORKSPACE_TEXT_TRANSPORT',
  'MATCHACLAW_WORKSPACE_BINARY_TRANSPORT',
  'MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT',
  'MATCHACLAW_WORKSPACE_WRITE_TRANSPORT',
  'MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT',
  'MATCHACLAW_SESSION_SEND_TRANSPORT',
  'MATCHACLAW_SESSION_ABORT_TRANSPORT',
  'MATCHACLAW_OPENCLAW_HISTORY_TRANSPORT',
  'MATCHACLAW_MATCHA_HISTORY_TRANSPORT',
  'MATCHACLAW_USAGE_TRANSPORT',
  'MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT',
  'MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT',
  'MATCHACLAW_CHANNEL_STATUS_TRANSPORT',
  'MATCHACLAW_CHANNEL_CONTROL_TRANSPORT',
  'MATCHACLAW_CHANNEL_PAIRING_TRANSPORT',
  'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT',
  'MATCHACLAW_SECURITY_POLICY_TRANSPORT',
  'MATCHACLAW_SESSION_APPROVAL_TRANSPORT',
  'MATCHACLAW_AGENTS_TRANSPORT',
  'MATCHACLAW_CRON_TRANSPORT',
  'MATCHACLAW_TASK_MANAGER_TRANSPORT',
  'MATCHACLAW_TEAM_PUBLIC_TRANSPORT',
  'MATCHACLAW_TEAM_APPROVALS_TRANSPORT',
  'MATCHACLAW_TEAM_DECISION_TRANSPORT',
  'MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT',
  'MATCHACLAW_TEAM_GRAPH_TRANSPORT',
  'MATCHACLAW_PROVIDER_MODELS_TRANSPORT',
  'MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT',
  'MATCHA_AGENT_APP_SERVER',
  'OPENCLAW_GATEWAY',
] as const;

const directPortKeys = [
  'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT',
  'MATCHACLAW_SECURITY_POLICY_TRANSPORT',
  'MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT',
  'MATCHACLAW_TEAM_SKILL_TRANSPORT',
  'MATCHACLAW_TEAM_TRIGGER_TRANSPORT',
  'MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT',
  'MATCHACLAW_MANUAL_TEAM_TRANSPORT',
] as const;

type E2EStartupState = Readonly<{
  outcome: unknown;
  launchDiagnostic: unknown;
}>;

type E2EOpenClawState = Readonly<{
  lifecycle: unknown;
  control: unknown;
  sessionSendBoundary: unknown;
  hostApiBoundary: unknown;
  sessionSendCapability: unknown;
  cronProviderTrace: unknown;
}>;

async function readE2EStartupState(electronApp: ElectronApplication): Promise<E2EStartupState> {
  return await electronApp.evaluate(() => {
    const e2eProcess = process as typeof process & {
      __matchaclawE2EStartupOutcome?: unknown;
      __matchaclawE2ELaunchDiagnostic?: unknown;
    };
    return {
      outcome: e2eProcess.__matchaclawE2EStartupOutcome ?? null,
      launchDiagnostic: e2eProcess.__matchaclawE2ELaunchDiagnostic ?? null,
    };
  });
}

function startupFailed(state: E2EStartupState): boolean {
  if (!state.outcome || typeof state.outcome !== 'object') return false;
  const outcome = state.outcome as { readonly stage?: unknown; readonly outcome?: unknown };
  return !(outcome.stage === 'ready' && outcome.outcome === 'started');
}

export async function readE2EOpenClawState(electronApp: ElectronApplication): Promise<E2EOpenClawState> {
  return await electronApp.evaluate(() => {
    const e2eProcess = process as typeof process & {
      __matchaclawE2EOpenClawLifecycle?: unknown;
      __matchaclawE2EOpenClawControlReadiness?: unknown;
      __matchaclawE2ESessionSendBoundary?: unknown;
      __matchaclawE2EHostApiBoundary?: unknown;
      __matchaclawE2ESessionSendCapability?: unknown;
      __matchaclawE2ECronProviderTrace?: unknown;
    };
    return {
      lifecycle: e2eProcess.__matchaclawE2EOpenClawLifecycle ?? null,
      control: e2eProcess.__matchaclawE2EOpenClawControlReadiness ?? null,
      sessionSendBoundary: e2eProcess.__matchaclawE2ESessionSendBoundary ?? null,
      hostApiBoundary: e2eProcess.__matchaclawE2EHostApiBoundary ?? null,
      sessionSendCapability: e2eProcess.__matchaclawE2ESessionSendCapability ?? null,
      cronProviderTrace: e2eProcess.__matchaclawE2ECronProviderTrace ?? null,
    };
  });
}

export async function enterLocalWorkspace(page: Page): Promise<void> {
  const chatHeading = page.getByRole('heading', { name: /MatchaClaw 聊天|MatchaClaw Chat/i });
  const localEntry = page.getByRole('button', { name: /游客进入|离线进入|Enter as guest|Enter offline/i }).first();
  await expect(chatHeading.or(localEntry)).toBeVisible({ timeout: 45_000 });

  if (await localEntry.isVisible().catch(() => false)) {
    await localEntry.click();
  }

  await expect(chatHeading).toBeVisible({ timeout: 45_000 });
}


async function waitForPrimaryWindow(
  electronApp: ElectronApplication,
  timeoutMs = 45_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = electronApp.windows().filter((window) => !window.isClosed());
    if (windows.length > 0) {
      const window = windows[0];
      const pageUrl = window.url();
      if (pageUrl !== 'about:blank') {
        await window.waitForLoadState('domcontentloaded');
        return window;
      }
    }

    const startupState = await readE2EStartupState(electronApp);
    if (startupFailed(startupState)) {
      throw new Error(`Electron startup failed: ${JSON.stringify(startupState)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const startupState = await readE2EStartupState(electronApp);
  throw new Error(`Timed out waiting for Electron window after ${timeoutMs}ms: ${JSON.stringify(startupState)}`);
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

async function allocateDistinctPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await allocateFreePort());
  }
  return [...ports];
}

export const test = base.extend<ElectronFixtures>({
  profileDir: [async ({}, use) => {
    const reusable = reusableProfileDir();
    if (reusable) {
      await mkdir(reusable, { recursive: true });
      await use(reusable);
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'matchaclaw-e2e-profile-'));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],

  homeDir: async ({ profileDir }, use) => {
    await use(profileDir);
  },

  electronApp: async ({ homeDir }, use) => {
    const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;

    const configuredUserDataDir = explicitUserDataDir();
    const userDataDir = configuredUserDataDir ?? join(homeDir, 'user-data');
    const appDataDir = join(homeDir, 'AppData', 'Roaming');
    const localAppDataDir = join(homeDir, 'AppData', 'Local');
    await mkdir(userDataDir, { recursive: true });
    await mkdir(appDataDir, { recursive: true });
    await mkdir(localAppDataDir, { recursive: true });

    const mainEntry = join(process.cwd(), 'dist-electron', 'main', 'index.js');
    const preloadEntry = join(process.cwd(), 'dist-electron', 'preload', 'index.js');
    const rendererIndex = join(process.cwd(), 'dist', 'index.html');
    await ensurePathExists(mainEntry);
    await ensurePathExists(preloadEntry);
    await ensurePathExists(rendererIndex);

    const ports = await allocateDistinctPorts(2 + portKeys.length + directPortKeys.length);
    const [hostApiPort, runtimeHostPort, ...bootstrapPorts] = ports;
    const bootstrapEnvironment = Object.fromEntries([
      ...portKeys.map((key, index) => [
        key === 'MATCHA_AGENT_APP_SERVER'
          ? 'MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT'
          : `MATCHACLAW_PORT_${key}`,
        String(bootstrapPorts[index]),
      ]),
      ...directPortKeys.map((key, index) => [key, String(bootstrapPorts[portKeys.length + index])]),
    ]);
    const launchEnv = {
      ...process.env,
      ...bootstrapEnvironment,
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

    const app = await electron.launch({ args: [mainEntry], env: launchEnv });

    try {
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
