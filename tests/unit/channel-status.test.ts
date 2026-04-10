import { describe, expect, it } from 'vitest';
import {
  computeChannelRuntimeStatus,
  pickChannelRuntimeStatus,
} from '@/lib/channel-status';

describe('channel runtime status helpers', () => {
  it('将健康的 running 账号视为 connected', () => {
    expect(
      computeChannelRuntimeStatus({
        running: true,
        connected: false,
        linked: false,
      }),
    ).toBe('connected');
  });

  it('将 probe.ok=true 视为 connected', () => {
    expect(
      computeChannelRuntimeStatus({
        running: false,
        probe: { ok: true },
      }),
    ).toBe('connected');
  });

  it('存在 lastError 时返回 error', () => {
    expect(
      computeChannelRuntimeStatus({
        running: true,
        lastError: 'token invalid',
      }),
    ).toBe('error');
  });

  it('多账号场景下：有健康账号时整体保持 connected', () => {
    expect(
      pickChannelRuntimeStatus([
        { running: true, connected: false, lastError: null },
        { connected: false, running: false, lastError: 'boom' },
      ]),
    ).toBe('connected');
  });

  it('无健康账号且 summary 报错时返回 error', () => {
    expect(
      pickChannelRuntimeStatus(
        [{ connected: false, running: false }],
        { error: 'bootstrap failed' },
      ),
    ).toBe('error');
  });
});
