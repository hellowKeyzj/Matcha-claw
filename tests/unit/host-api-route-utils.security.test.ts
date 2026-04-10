import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { PORTS } from '../../electron/utils/config';
import { requireJsonContentType, setCorsHeaders } from '../../electron/api/route-utils';

function makeReq(
  method: string,
  headers: Record<string, string | undefined>,
): IncomingMessage {
  return {
    method,
    headers,
  } as unknown as IncomingMessage;
}

function makeRes() {
  return {
    setHeader: vi.fn(),
  } as unknown as ServerResponse;
}

describe('host api route-utils security', () => {
  it('拒绝带 body 但非 json 的变更请求', () => {
    const req = makeReq('POST', {
      'content-length': '12',
      'content-type': 'text/plain',
    });
    expect(requireJsonContentType(req)).toBe(false);
  });

  it('允许 GET / OPTIONS / HEAD 通过 content-type 校验', () => {
    expect(requireJsonContentType(makeReq('GET', {}))).toBe(true);
    expect(requireJsonContentType(makeReq('OPTIONS', {}))).toBe(true);
    expect(requireJsonContentType(makeReq('HEAD', {}))).toBe(true);
  });

  it('仅对 allowlist origin 回写 Access-Control-Allow-Origin', () => {
    const knownOrigin = `http://127.0.0.1:${PORTS.CLAWX_DEV}`;
    const unknownOrigin = 'https://evil.example.com';

    const resKnown = makeRes();
    setCorsHeaders(resKnown, knownOrigin);
    expect((resKnown as unknown as { setHeader: ReturnType<typeof vi.fn> }).setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      knownOrigin,
    );

    const resUnknown = makeRes();
    setCorsHeaders(resUnknown, unknownOrigin);
    expect((resUnknown as unknown as { setHeader: ReturnType<typeof vi.fn> }).setHeader).not.toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      unknownOrigin,
    );
  });
});
