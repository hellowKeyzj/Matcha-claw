import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function allocateFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port allocation failed');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function allocateDistinctPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await allocateFreePort());
  }
  return [...ports];
}

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'matchaclaw-real-electron-'));
  const userDataDir = join(homeDir, 'user-data');
  const appDataDir = join(homeDir, 'AppData', 'Roaming');
  const localAppDataDir = join(homeDir, 'AppData', 'Local');
  await Promise.all([mkdir(userDataDir, { recursive: true }), mkdir(appDataDir, { recursive: true }), mkdir(localAppDataDir, { recursive: true })]);
  const [hostApiPort, runtimeHostPort, matchaAgentPort, openClawPort] = await allocateDistinctPorts(4);
  const app = await electron.launch({
    args: [join(process.cwd(), 'dist-electron', 'main', 'index.js')],
    env: {
      ...process.env,
      MATCHACLAW_E2E: '1',
      MATCHACLAW_E2E_USER_DATA_DIR: userDataDir,
      MATCHACLAW_PORT_MATCHACLAW_HOST_API: String(hostApiPort),
      MATCHACLAW_RUNTIME_HOST_PORT: String(runtimeHostPort),
      MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT: String(matchaAgentPort),
      MATCHACLAW_PORT_OPENCLAW_GATEWAY: String(openClawPort),
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const processState = await app.evaluate(() => ({
      cwd: process.cwd(),
      execPath: process.execPath,
      resourcesPath: (process as typeof process & { resourcesPath?: string }).resourcesPath ?? null,
      platform: process.platform,
      arch: process.arch,
    }));
    const { outcome, launchDiagnostic } = await app.evaluate(() => {
      const e2eProcess = process as typeof process & {
        __matchaclawE2EStartupOutcome?: unknown;
        __matchaclawE2ELaunchDiagnostic?: unknown;
      };
      return {
        outcome: e2eProcess.__matchaclawE2EStartupOutcome ?? null,
        launchDiagnostic: e2eProcess.__matchaclawE2ELaunchDiagnostic ?? null,
      };
    });
    console.log(JSON.stringify({ windows: app.windows().filter((window) => !window.isClosed()).length, outcome, launchDiagnostic, processState }));
  } finally {
    await app.close().catch(() => undefined);
    await rm(homeDir, { recursive: true, force: true });
  }
}

void main();
