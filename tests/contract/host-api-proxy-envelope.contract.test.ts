import { describe, expect, it } from 'vitest';
import {
  decodeHostApiProxyEnvelope,
  resolveHostApiProxyErrorMessage,
  unwrapHostApiProxyEnvelope,
} from '../../src/lib/host-api-transport-contract';

describe('host-api proxy envelope contract', () => {
  it('接受统一成功包络并解码 json', () => {
    const envelope = decodeHostApiProxyEnvelope({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { value: 1 },
      },
    });

    const parsed = unwrapHostApiProxyEnvelope<{ value: number }>(envelope, {
      method: 'GET',
      path: '/api/demo',
    });
    expect(parsed.status).toBe(200);
    expect(parsed.data).toEqual({ value: 1 });
  });

  it('拒绝旧版 legacy 包络（success/status/json）', () => {
    expect(() => decodeHostApiProxyEnvelope({
      success: true,
      status: 200,
      json: { value: 1 },
    })).toThrow('missing boolean ok');
  });

  it('当业务错误被放在 success 包络里时必须抛错，不能当成功体返回', () => {
    const envelope = decodeHostApiProxyEnvelope({
      ok: true,
      data: {
        status: 500,
        ok: false,
        json: {
          success: false,
          error: 'Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)',
        },
      },
    });

    expect(() => unwrapHostApiProxyEnvelope(envelope, {
      method: 'GET',
      path: '/api/cron/jobs',
    })).toThrow('Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)');
  });

  it('失败包络必须有 error.message，且可被统一取错', () => {
    const envelope = decodeHostApiProxyEnvelope({
      ok: false,
      error: { message: 'Invalid Authentication' },
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(resolveHostApiProxyErrorMessage(envelope.error)).toBe('Invalid Authentication');
    }
  });
});
