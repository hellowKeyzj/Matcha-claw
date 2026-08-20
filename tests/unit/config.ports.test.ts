import { afterEach, describe, expect, it } from 'vitest';
import { PORTS, getPort } from '../../electron/utils/config';

const envBackup = { ...process.env };

function resetPortEnv(): void {
  process.env = { ...envBackup };
  delete process.env.MATCHACLAW_PORT_MATCHACLAW_HOST_API;
  delete process.env.MATCHACLAW_RUNTIME_HOST_PORT;
  delete process.env.MATCHACLAW_SETTINGS_DESIRED_TRANSPORT;
  delete process.env.MATCHACLAW_SECURITY_POLICY_TRANSPORT;
  delete process.env.MATCHACLAW_CRON_BROKER_TRANSPORT;
}

afterEach(() => {
  resetPortEnv();
});

describe('config ports', () => {
  it('Host API 端口键仅保留 MATCHACLAW_HOST_API', () => {
    expect(PORTS.MATCHACLAW_HOST_API).toBe(13210);
  });

  it('读取 MATCHACLAW_HOST_API 环境变量', () => {
    process.env.MATCHACLAW_PORT_MATCHACLAW_HOST_API = '4321';
    expect(getPort('MATCHACLAW_HOST_API')).toBe(4321);
  });

  it('runtime-host 端口通过 MATCHACLAW_RUNTIME_HOST_PORT 读取', () => {
    process.env.MATCHACLAW_RUNTIME_HOST_PORT = '4324';
    expect(getPort('MATCHACLAW_RUNTIME_HOST')).toBe(4324);
  });

  it('exposes a dedicated OpenClaw usage history transport port', () => {
    expect(PORTS.MATCHACLAW_USAGE_TRANSPORT).toBe(3243);
  });

  it('reads exact Settings and Security transport environment variables', () => {
    process.env.MATCHACLAW_SETTINGS_DESIRED_TRANSPORT = '42136';
    process.env.MATCHACLAW_SECURITY_POLICY_TRANSPORT = '42137';

    expect(getPort('MATCHACLAW_SETTINGS_DESIRED_TRANSPORT')).toBe(42136);
    expect(getPort('MATCHACLAW_SECURITY_POLICY_TRANSPORT')).toBe(42137);
  });

  it.each([
    ['MATCHACLAW_SETTINGS_DESIRED_TRANSPORT', '32136x'],
    ['MATCHACLAW_SECURITY_POLICY_TRANSPORT', '65536'],
  ] as const)('rejects invalid %s override', (name, value) => {
    process.env[name] = value;
    expect(getPort(name)).toBe(PORTS[name]);
  });

  it('exposes dedicated Settings and Security transport ports', () => {
    expect(PORTS.MATCHACLAW_SETTINGS_DESIRED_TRANSPORT).toBe(32136);
    expect(PORTS.MATCHACLAW_SECURITY_POLICY_TRANSPORT).toBe(32137);
  });

  it('exposes a dedicated Task Manager transport port', () => {
    expect(PORTS.MATCHACLAW_TASK_MANAGER_TRANSPORT).toBe(3245);
  });

  it('exposes a dedicated Cron broker transport port', () => {
    expect(PORTS.MATCHACLAW_CRON_BROKER_TRANSPORT).toBe(3250);
  });

  it('reads only the dedicated Cron broker environment variable', () => {
    process.env.MATCHACLAW_CRON_BROKER_TRANSPORT = '4325';
    process.env.MATCHACLAW_PORT_MATCHACLAW_CRON_BROKER_TRANSPORT = '4326';

    expect(getPort('MATCHACLAW_CRON_BROKER_TRANSPORT')).toBe(4325);
  });
});
