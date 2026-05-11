import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeLogger } from '../../runtime-host/shared/logger';
import {
  isTraceLogLevelEnabled as isRuntimeTraceLogLevelEnabled,
  resolveTraceLogLevel as resolveRuntimeTraceLogLevel,
} from '../../runtime-host/shared/trace-log-level';
import {
  isTraceLogLevelEnabled as isElectronTraceLogLevelEnabled,
  resolveTraceLogLevel as resolveElectronTraceLogLevel,
} from '../../electron/utils/trace-log-level';

const originalTraceLogLevel = process.env.MATCHACLAW_TRACE_LOG_LEVEL;

afterEach(() => {
  if (originalTraceLogLevel === undefined) {
    delete process.env.MATCHACLAW_TRACE_LOG_LEVEL;
  } else {
    process.env.MATCHACLAW_TRACE_LOG_LEVEL = originalTraceLogLevel;
  }
});

describe('trace log level', () => {
  it('默认关闭调测链路日志', () => {
    expect(isRuntimeTraceLogLevelEnabled(undefined, 3)).toBe(false);
    expect(isElectronTraceLogLevelEnabled('', 2)).toBe(false);
  });

  it('支持全量开启', () => {
    expect(isRuntimeTraceLogLevelEnabled('7', 7)).toBe(true);
    expect(isRuntimeTraceLogLevelEnabled('all', 7)).toBe(true);
    expect(isElectronTraceLogLevelEnabled('*', 7)).toBe(true);
  });

  it('按数字阈值控制打印详细程度', () => {
    expect(resolveRuntimeTraceLogLevel('2')).toBe(2);
    expect(resolveElectronTraceLogLevel('99')).toBe(7);
    expect(isRuntimeTraceLogLevelEnabled('2', 1)).toBe(true);
    expect(isRuntimeTraceLogLevelEnabled('2', 2)).toBe(true);
    expect(isRuntimeTraceLogLevelEnabled('2', 3)).toBe(false);
  });

  it('runtime logger 的 traceDebug 受 MATCHACLAW_TRACE_LOG_LEVEL 控制', () => {
    const debug = vi.fn();
    const logger = createRuntimeLogger(
      'test',
      { nowIso: () => '2026-05-11T00:00:00.000Z' },
      {
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    delete process.env.MATCHACLAW_TRACE_LOG_LEVEL;
    logger.traceDebug?.(3, '[gateway-rpc] start', { method: 'channels.status' });
    expect(debug).not.toHaveBeenCalled();

    process.env.MATCHACLAW_TRACE_LOG_LEVEL = '3';
    logger.traceDebug?.(3, '[gateway-rpc] start', { method: 'channels.status' });
    expect(debug).toHaveBeenCalledWith(
      '[2026-05-11T00:00:00.000Z] [DEBUG] [runtime-host:test] [gateway-rpc] start {"method":"channels.status"}',
    );
  });
});
