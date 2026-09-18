import { afterEach, describe, expect, it } from 'vitest';
import { PORTS, getPort } from '../../electron/utils/config';

const envBackup = { ...process.env };

function resetPortEnv(): void {
  process.env = { ...envBackup };
  delete process.env.MATCHACLAW_PORT_MATCHACLAW_HOST_API;
  delete process.env.MATCHACLAW_RUNTIME_HOST_PORT;
  delete process.env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT;
  delete process.env.MATCHACLAW_PORT_OPENCLAW_GATEWAY;
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

  it('runtime-host transport 端口通过 MATCHACLAW_RUNTIME_HOST_PORT 读取', () => {
    process.env.MATCHACLAW_RUNTIME_HOST_PORT = '4324';
    expect(getPort('MATCHACLAW_RUNTIME_HOST')).toBe(4324);
  });

  it('keeps Matcha app-server and OpenClaw gateway as independent peer runtime ports', () => {
    expect(PORTS.MATCHA_AGENT_APP_SERVER).toBe(3212);
    expect(PORTS.OPENCLAW_GATEWAY).toBe(18789);
  });

  it('reads Matcha app-server and OpenClaw gateway environment variables independently', () => {
    process.env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT = '42112';
    process.env.MATCHACLAW_PORT_OPENCLAW_GATEWAY = '42189';

    expect(getPort('MATCHA_AGENT_APP_SERVER')).toBe(42112);
    expect(getPort('OPENCLAW_GATEWAY')).toBe(42189);
  });
});
