import { describe, expect, it } from 'vitest';
import { stripSystemdSupervisorEnv } from '../../electron/gateway/config-sync-env';

describe('stripSystemdSupervisorEnv', () => {
  it('移除 systemd 监督环境变量', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service',
      INVOCATION_ID: 'abc123',
      SYSTEMD_EXEC_PID: '777',
      JOURNAL_STREAM: '8:12345',
      OTHER: 'keep-me',
    };

    const result = stripSystemdSupervisorEnv(env);

    expect(result).toEqual({
      PATH: '/usr/bin:/bin',
      OTHER: 'keep-me',
    });
  });

  it('不会修改输入对象', () => {
    const env = {
      OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service',
      VALUE: '1',
    };
    const before = { ...env };

    const result = stripSystemdSupervisorEnv(env);

    expect(env).toEqual(before);
    expect(result).toEqual({ VALUE: '1' });
  });
});
