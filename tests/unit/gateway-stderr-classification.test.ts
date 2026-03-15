import { describe, expect, it } from 'vitest';
import { classifyGatewayStderrMessage } from '@electron/gateway/startup-stderr';

describe('gateway stderr classification', () => {
  it('将 skills 越界路径告警降级为 debug，保留可观测性', () => {
    const classified = classifyGatewayStderrMessage(
      '2026-03-15T17:23:34.964+08:00 [skills] Skipping skill path that resolves outside its configured root.',
    );
    expect(classified.level).toBe('debug');
  });
});
