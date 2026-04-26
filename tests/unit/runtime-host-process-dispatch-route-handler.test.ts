import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { handleDispatchRoute } from '../../runtime-host/api/dispatch/dispatch-route-handler';

class FakeRequest extends EventEmitter {
  private readonly body: string;

  constructor(body: string) {
    super();
    this.body = body;
  }

  start() {
    setImmediate(() => {
      this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
  }
}

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  bodyText = '';
  private readonly doneResolver: () => void;
  readonly done: Promise<void>;

  constructor() {
    let resolveDone = () => {};
    this.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.doneResolver = resolveDone;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  end(payload?: string) {
    if (typeof payload === 'string') {
      this.bodyText += payload;
    }
    this.doneResolver();
  }
}

function createTransportStats() {
  return {
    totalDispatchRequests: 0,
    localBusinessHandled: 0,
    unhandledRouteCount: 0,
    badRequestRejected: 0,
    dispatchInternalError: 0,
  };
}

async function runDispatch(
  requestPayload: unknown,
  overrides?: Partial<{
    tryHandleLocalBusinessDispatch: (
      method: string,
      route: string,
      payload: unknown,
    ) => Promise<{ status: number; data: unknown } | null>;
  }>,
) {
  const transportStats = createTransportStats();
  const tryHandleLocalBusinessDispatch = overrides?.tryHandleLocalBusinessDispatch
    || vi.fn(async () => null);

  const req = new FakeRequest(JSON.stringify(requestPayload));
  const res = new FakeResponse();

  handleDispatchRoute(req, res, {
    transportStats,
    tryHandleLocalBusinessDispatch,
  });
  req.start();
  await res.done;

  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.bodyText || '{}') as Record<string, unknown>,
    transportStats,
    mocks: {
      tryHandleLocalBusinessDispatch,
    },
  };
}

describe('runtime-host process dispatch route handler', () => {
  it('本地业务命中时返回 local response 并累计统计', async () => {
    const result = await runDispatch(
      {
        version: 1,
        method: 'GET',
        route: '/api/workbench/bootstrap',
      },
      {
        tryHandleLocalBusinessDispatch: vi.fn(async () => ({
          status: 200,
          data: { success: true, source: 'local' },
        })),
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data).toEqual({ success: true, source: 'local' });
    expect(result.transportStats.totalDispatchRequests).toBe(1);
    expect(result.transportStats.localBusinessHandled).toBe(1);
  });

  it('transport version 不匹配时返回 BAD_REQUEST', async () => {
    const result = await runDispatch({
      version: 999,
      method: 'GET',
      route: '/api/workbench/bootstrap',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual(
      expect.objectContaining({
        code: 'BAD_REQUEST',
      }),
    );
    expect(result.transportStats.badRequestRejected).toBe(1);
  });

  it('未命中任何路由时返回 NOT_FOUND 并累计 unhandled 计数', async () => {
    const result = await runDispatch({
      version: 1,
      method: 'POST',
      route: '/api/plugins/runtime/restart',
    });

    expect(result.statusCode).toBe(404);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual(
      expect.objectContaining({
        code: 'NOT_FOUND',
      }),
    );
    expect(result.transportStats.unhandledRouteCount).toBe(1);
  });
});
