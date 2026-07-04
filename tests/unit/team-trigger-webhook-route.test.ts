import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamRuntimeWebhookHandler, isTeamRuntimeWebhookPath } from '../../runtime-host/api/routes/team-runtime-webhook-routes';
import type { TeamRuntimePort } from '../../runtime-host/application/team-runtime/team-runtime-port';

function makeRequest(method: string, url: string, headers: Record<string, string> = {}, body = ''): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers });
  return req as unknown as IncomingMessage;
}

function makeResponse(): { statusCode: number; headers: Record<string, string>; body?: string; setHeader: (name: string, value: string) => void; end: (body: string) => void } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((name: string, value: string) => {
      res.headers[name] = value;
    }),
    end: vi.fn((body: string) => {
      res.body = body;
    }),
  };
  return res;
}

function responseJson(res: { body?: string }): Record<string, unknown> {
  return JSON.parse(res.body ?? '{}') as Record<string, unknown>;
}

function createTestBodyHasher(): { update: (chunk: Uint8Array) => void; digest: () => string } {
  const chunks: Uint8Array[] = [];
  return {
    update: (chunk) => { chunks.push(chunk); },
    digest: () => Buffer.concat(chunks).toString('hex'),
  };
}

function makeTeamRuntimeService(response = { status: 200, data: { success: true, fired: true } }): { service: TeamRuntimePort; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => response);
  return { service: { invoke } as unknown as TeamRuntimePort, invoke };
}

function createWebhookHandler(input: {
  token: string | (() => string | Promise<string>);
  teamRuntimeService: TeamRuntimePort;
  createWebhookRequestId?: () => string;
}) {
  return createTeamRuntimeWebhookHandler({
    token: input.token,
    teamRuntimeService: input.teamRuntimeService,
    isWebhookTokenAuthorized: (actualToken, expectedToken) => actualToken === expectedToken,
    createWebhookBodyHasher: () => createTestBodyHasher(),
    createWebhookRequestId: input.createWebhookRequestId ?? (() => 'generated-webhook-request-id'),
  });
}

describe('team runtime webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches only runtime-host TeamRun webhook paths', () => {
    expect(isTeamRuntimeWebhookPath('/api/team-runtime/webhooks')).toBe(true);
    expect(isTeamRuntimeWebhookPath('/api/team-runtime/webhooks/deploy/ready')).toBe(true);
    expect(isTeamRuntimeWebhookPath('/team-runtime/triggers/run-1/start-1')).toBe(false);
  });

  it('is deny-first when MATCHACLAW_TEAM_WEBHOOK_TOKEN is empty', async () => {
    const { service, invoke } = makeTeamRuntimeService();
    const handler = createWebhookHandler({ token: '', teamRuntimeService: service });
    const res = makeResponse();

    await handler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { authorization: 'Bearer secret' }), res);

    expect(res.statusCode).toBe(404);
    expect(responseJson(res)).toMatchObject({ success: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires the configured webhook token before dispatching', async () => {
    const { service, invoke } = makeTeamRuntimeService();
    const handler = createWebhookHandler({ token: 'secret', teamRuntimeService: service });
    const res = makeResponse();

    await handler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { authorization: 'Bearer wrong' }), res);

    expect(res.statusCode).toBe(401);
    expect(responseJson(res)).toMatchObject({ success: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('waits for a runtime-managed webhook token provider before authorizing', async () => {
    const { service, invoke } = makeTeamRuntimeService();
    const token = vi.fn(async () => 'secret');
    const handler = createWebhookHandler({ token, teamRuntimeService: service });
    const res = makeResponse();

    await handler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { authorization: 'Bearer secret' }), res);

    expect(token).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(202);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('team.webhookTriggerFire', expect.any(Object), expect.any(Object));
  });

  it('dispatches one R3 webhook operation without matching triggers or persisting raw body', async () => {
    const { service, invoke } = makeTeamRuntimeService();
    const handler = createWebhookHandler({ token: 'secret', teamRuntimeService: service });
    const res = makeResponse();
    const body = '{"token":"secret-value","message":"hello"}';

    await handler(makeRequest(
      'POST',
      '/api/team-runtime/webhooks/deploy/ready',
      {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-idempotency-key': 'request-1',
        'x-matchaclaw-webhook-token': 'secret-should-not-be-forwarded',
      },
      body,
    ), res);

    expect(res.statusCode).toBe(202);
    expect(responseJson(res)).toMatchObject({ success: true, fired: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('team.webhookTriggerFire', expect.objectContaining({
      webhookPath: 'deploy/ready',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'request-1',
      },
      idempotencyKey: 'request-1',
      payloadSummary: `body:${Buffer.byteLength(body)} bytes`,
      deterministicBodyHash: expect.any(String),
      payload: expect.objectContaining({
        contentType: 'application/json',
        bodyHash: expect.any(String),
        bodyText: '{"token":"[redacted]","message":"hello"}',
        bodyJson: { token: '[redacted]', message: 'hello' },
      }),
    }), {
      kind: 'runtime-instance',
      endpoint: { kind: 'native-runtime', runtimeAdapterId: 'runtime-host', runtimeInstanceId: 'local' },
    });
    const fireParams = invoke.mock.calls[0]?.[1] as { headers?: Record<string, string>; payloadSummary?: string };
    expect(fireParams.headers).not.toHaveProperty('authorization');
    expect(fireParams.headers).not.toHaveProperty('x-matchaclaw-webhook-token');
    expect(fireParams.payloadSummary).not.toContain('secret-value');
  });

  it('passes no-match and duplicate decisions through from the R3 webhook operation', async () => {
    const noMatch = makeTeamRuntimeService({ status: 404, data: { success: false, error: 'No armed TeamRun webhook trigger matches this path.' } });
    const noMatchHandler = createWebhookHandler({ token: 'secret', teamRuntimeService: noMatch.service });
    const noMatchRes = makeResponse();

    await noMatchHandler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/missing', { 'x-matchaclaw-webhook-token': 'secret' }), noMatchRes);

    expect(noMatchRes.statusCode).toBe(404);
    expect(responseJson(noMatchRes)).toMatchObject({ success: false, error: 'No armed TeamRun webhook trigger matches this path.' });
    expect(noMatch.invoke).toHaveBeenCalledTimes(1);
    expect(noMatch.invoke).toHaveBeenCalledWith('team.webhookTriggerFire', expect.objectContaining({ webhookPath: 'deploy/missing' }), expect.any(Object));

    const duplicate = makeTeamRuntimeService({ status: 409, data: { success: false, error: 'Multiple armed TeamRun webhook triggers match this path.' } });
    const duplicateHandler = createWebhookHandler({ token: 'secret', teamRuntimeService: duplicate.service });
    const duplicateRes = makeResponse();

    await duplicateHandler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { 'x-matchaclaw-webhook-token': 'secret' }), duplicateRes);

    expect(duplicateRes.statusCode).toBe(409);
    expect(responseJson(duplicateRes)).toMatchObject({ success: false, error: 'Multiple armed TeamRun webhook triggers match this path.' });
    expect(duplicate.invoke).toHaveBeenCalledTimes(1);
    expect(duplicate.invoke).toHaveBeenCalledWith('team.webhookTriggerFire', expect.objectContaining({ webhookPath: 'deploy/ready' }), expect.any(Object));
  });

  it('rejects oversized bodies before dispatching', async () => {
    const { service, invoke } = makeTeamRuntimeService();
    const handler = createWebhookHandler({ token: 'secret', teamRuntimeService: service });
    const res = makeResponse();

    await handler(makeRequest(
      'POST',
      '/api/team-runtime/webhooks/deploy/ready',
      { authorization: 'Bearer secret' },
      'x'.repeat(64 * 1024 + 1),
    ), res);

    expect(res.statusCode).toBe(413);
    expect(responseJson(res)).toMatchObject({ success: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses a request id for fallback idempotency while keeping the body hash as payload evidence', async () => {
    const first = makeTeamRuntimeService();
    const firstHandler = createWebhookHandler({ token: 'secret', teamRuntimeService: first.service, createWebhookRequestId: () => 'generated-webhook-request-id-1' });
    const firstRes = makeResponse();

    await firstHandler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { authorization: 'Bearer secret' }, 'same-body'), firstRes);

    const second = makeTeamRuntimeService();
    const secondHandler = createWebhookHandler({ token: 'secret', teamRuntimeService: second.service, createWebhookRequestId: () => 'generated-webhook-request-id-2' });
    const secondRes = makeResponse();

    await secondHandler(makeRequest('POST', '/api/team-runtime/webhooks/deploy/ready', { authorization: 'Bearer secret' }, 'same-body'), secondRes);

    const firstParams = first.invoke.mock.calls[0]?.[1] as { idempotencyKey?: string; deterministicBodyHash: string; payload?: { bodyHash?: string } };
    const secondParams = second.invoke.mock.calls[0]?.[1] as { idempotencyKey?: string; deterministicBodyHash: string; payload?: { bodyHash?: string } };
    expect(firstParams.idempotencyKey).toBe('generated-webhook-request-id-1');
    expect(secondParams.idempotencyKey).toBe('generated-webhook-request-id-2');
    expect(firstParams.deterministicBodyHash).toBe(secondParams.deterministicBodyHash);
    expect(firstParams.payload?.bodyHash).toBe(firstParams.deterministicBodyHash);
  });
});
