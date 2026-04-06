import { describe, expect, it } from 'vitest';
import { parseDispatchEnvelope } from '../../runtime-host/api/dispatch/dispatch-envelope';

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
});
