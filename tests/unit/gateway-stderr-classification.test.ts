import { describe, expect, it } from 'vitest';
import {
  classifyGatewayStderrMessage,
  shouldSuppressGatewayStderrRepeat,
} from '@electron/gateway/startup-stderr';

describe('gateway stderr classification', () => {
  it('将 skills 越界路径告警降级为 debug，保留可观测性', () => {
    const classified = classifyGatewayStderrMessage(
      '2026-03-15T17:23:34.964+08:00 [skills] Skipping skill path that resolves outside its configured root.',
    );
    expect(classified.level).toBe('debug');
  });

  it('将 Config warnings 降级为 debug，避免误报启动错误', () => {
    const classified = classifyGatewayStderrMessage('Config warnings: plugin id mismatch: qqbot');
    expect(classified.level).toBe('debug');
  });

  it('重复 stderr 行会在首条后被抑制，并按阈值输出汇总信号', () => {
    const dedupCounter = new Map<string, number>();
    const line = '[gateway] repetitive warning';

    const first = shouldSuppressGatewayStderrRepeat(dedupCounter, line, 3);
    const second = shouldSuppressGatewayStderrRepeat(dedupCounter, line, 3);
    const third = shouldSuppressGatewayStderrRepeat(dedupCounter, line, 3);

    expect(first).toEqual({ suppress: false, repeatCount: 1, emitSummary: false });
    expect(second).toEqual({ suppress: true, repeatCount: 2, emitSummary: false });
    expect(third).toEqual({ suppress: true, repeatCount: 3, emitSummary: true });
  });
});
