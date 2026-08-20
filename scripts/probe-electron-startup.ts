import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(join(userDataDir, 'settings.json'), JSON.stringify({ setupComplete: true }), 'utf8');
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
  const app = await electron.launch({
    args: [join(process.cwd(), 'dist-electron', 'main', 'index.js')],
    env: {
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
