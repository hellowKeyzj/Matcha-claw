import { afterEach, describe, expect, it } from 'vitest';
import { PORTS, getPort } from '../../electron/utils/config';

const envBackup = { ...process.env };

function resetPortEnv(): void {
  process.env = { ...envBackup };
  delete process.env.MATCHACLAW_PORT_MATCHACLAW_HOST_API;
  delete process.env.MATCHACLAW_RUNTIME_HOST_PORT;
  delete process.env.CLAWX_PORT_CLAWX_HOST_API;
  delete process.env.MATCHACLAW_PORT_CLAWX_HOST_API;
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

  it('不再读取 CLAWX_HOST_API 兼容环境变量', () => {
    process.env.MATCHACLAW_PORT_CLAWX_HOST_API = '4322';
    process.env.CLAWX_PORT_CLAWX_HOST_API = '4323';
    expect(getPort('MATCHACLAW_HOST_API')).toBe(PORTS.MATCHACLAW_HOST_API);
  });
});
