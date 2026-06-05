import { describe, expect, it } from 'vitest';
import {
  DISPATCH_ENVELOPE_MAX_BODY_BYTES,
  parseDispatchEnvelope,
} from '../../runtime-host/api/dispatch/dispatch-envelope';

describe('runtime-host process dispatch envelope parser', () => {
  it('合法请求返回标准 envelope', () => {
    const result = parseDispatchEnvelope(JSON.stringify({
      version: 1,
      method: 'GET',
      route: '/api/workbench/bootstrap',
      payload: { a: 1 },
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        method: 'GET',
        route: '/api/workbench/bootstrap',
        payload: { a: 1 },
      },
    });
  });

  it('非法版本返回 BAD_REQUEST', () => {
    const result = parseDispatchEnvelope(JSON.stringify({
      version: 2,
      method: 'GET',
      route: '/api/workbench/bootstrap',
    }));
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: {
        code: 'BAD_REQUEST',
        message: 'Unsupported transport version: 2',
      },
    });
  });

  it('非法 route 返回 BAD_REQUEST', () => {
    const result = parseDispatchEnvelope(JSON.stringify({
      version: 1,
      method: 'GET',
      route: 'api/no-leading-slash',
    }));
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid route: api/no-leading-slash',
      },
    });
  });

  it('超大 body 在 JSON.parse 前返回 PAYLOAD_TOO_LARGE', () => {
    const rawBody = `{${' '.repeat(DISPATCH_ENVELOPE_MAX_BODY_BYTES)}}`;
    const result = parseDispatchEnvelope(rawBody);

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Dispatch envelope exceeds ${DISPATCH_ENVELOPE_MAX_BODY_BYTES} bytes`,
      },
    });
  });
});
