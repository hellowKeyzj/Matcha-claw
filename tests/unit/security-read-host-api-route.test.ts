import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSecurityRoutes } from '../../electron/api/routes/security';

function request(body?: unknown, method = 'GET') {
  return Object.assign(Readable.from(method === 'GET' ? [] : [JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const policy = {
  preset: 'balanced',
  securityPolicyVersion: 1,
  runtime: { requireApproval: true },
};

const audit = {
  page: 2,
  pageSize: 8,
  total: 1,
  items: [{
    ts: 1_725_000_000_000,
    toolName: 'shell.exec',
    risk: 'medium',
    action: 'audit',
    decision: 'observed',
  }],
};

const catalog = {
  success: true,
  total: 1,
  items: [{
    platform: 'windows',
    command: 'rmdir /s /q C:\\temp\\demo',
    category: 'file_delete',
    severity: 'critical',
    reason: '递归删除目录树',
  }],
};

describe('Security read Host API routes', () => {
  it('reads policy through the dedicated sealed transport', async () => {
    const read = vi.fn().mockResolvedValue(policy);
    const result = response();

    await expect(handleSecurityRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security'),
      { read, readAudit: vi.fn(), submit: vi.fn() },
      { read: vi.fn() },
      { run: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledOnce();
    expect(result.state).toEqual({ statusCode: 200, body: policy });
  });

  it('returns a stable unavailable policy error without a local fallback', async () => {
    const result = response();

    await handleSecurityRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security'),
      { read: vi.fn().mockResolvedValue(null), readAudit: vi.fn(), submit: vi.fn() },
      { read: vi.fn() },
      { run: vi.fn() },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Security policy is unavailable' },
    });
  });

  it('forwards only bounded page parameters to the fixed audit transport', async () => {
    const readAudit = vi.fn().mockResolvedValue(audit);
    const result = response();

    await expect(handleSecurityRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/audit?page=2&pageSize=8'),
      { read: vi.fn(), readAudit, submit: vi.fn() },
      { read: vi.fn() },
      { run: vi.fn() },
    )).resolves.toBe(true);

    expect(readAudit).toHaveBeenCalledWith(2, 8);
    expect(result.state).toEqual({ statusCode: 200, body: audit });
  });

  it('uses the fixed audit defaults and rejects arbitrary query forwarding', async () => {
    const readAudit = vi.fn().mockResolvedValue(audit);
    const transport = { read: vi.fn(), readAudit, submit: vi.fn() };

    const defaultResult = response();
    await handleSecurityRoutes(
      request() as never,
      defaultResult.raw as never,
      new URL('http://127.0.0.1/api/security/audit'),
      transport,
      { read: vi.fn() },
      { run: vi.fn() },
    );
    expect(readAudit).toHaveBeenCalledWith(1, 20);

    for (const query of [
      '?page=0',
      '?pageSize=201',
      '?page=1&page=2',
      '?page=1&platform=windows',
      '?page=1&token=secret',
      '?page=1.5',
    ]) {
      const result = response();
      await handleSecurityRoutes(
        request() as never,
        result.raw as never,
        new URL(`http://127.0.0.1/api/security/audit${query}`),
        transport,
        { read: vi.fn() },
        { run: vi.fn() },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Security audit request is invalid' },
      });
    }
    expect(readAudit).toHaveBeenCalledOnce();
  });

  it('forwards the catalog response and raw platform query through its dedicated transport', async () => {
    const result = response();
    const transport = { read: vi.fn(), readAudit: vi.fn(), submit: vi.fn() };
    const read = vi.fn().mockResolvedValue({ status: 200, body: catalog });

    await expect(handleSecurityRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/destructive-rule-catalog?platform=PowerShell'),
      transport,
      { read },
      { run: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith('PowerShell');
    expect(result.state).toEqual({ statusCode: 200, body: catalog });
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.readAudit).not.toHaveBeenCalled();
  });

  it('keeps the unavailable catalog response stable when delivery fails', async () => {
    const result = response();

    await handleSecurityRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/destructive-rule-catalog'),
      { read: vi.fn(), readAudit: vi.fn(), submit: vi.fn() },
      { read: vi.fn().mockRejectedValue(new Error('private native failure')) },
      { run: vi.fn() },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Security rule catalog is unavailable' },
    });
  });
});
