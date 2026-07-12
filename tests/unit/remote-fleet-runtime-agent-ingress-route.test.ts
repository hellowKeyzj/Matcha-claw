import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeAgentIngressRouteHandler,
  type RuntimeAgentIngressRouteDeps,
} from '../../runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route';

type FakeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
  setHeader: (name: string, value: string) => void;
  end: (payload: string) => void;
};

function makeRequest(input: {
  method?: string;
  headers?: Record<string, string>;
  chunks?: readonly Buffer[];
}): IncomingMessage {
  const request = Readable.from(input.chunks ?? []);
  Object.assign(request, {
    method: input.method ?? 'POST',
    headers: input.headers ?? {},
  });
  return request as unknown as IncomingMessage;
}

function jsonRequest(
  body: unknown,
  input: Omit<Parameters<typeof makeRequest>[0], 'chunks'> = {},
): IncomingMessage {
  return makeRequest({
    ...input,
    headers: {
      'content-type': 'application/json',
      ...input.headers,
    },
    chunks: [Buffer.from(JSON.stringify(body))],
  });
}

function makeResponse(): FakeResponse {
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    bodyText: '',
    setHeader: vi.fn((name: string, value: string) => {
      response.headers[name] = value;
    }),
    end: vi.fn((payload: string) => {
      response.bodyText += payload;
    }),
  };
  return response;
}

function responseJson(response: FakeResponse): Record<string, unknown> {
  return JSON.parse(response.bodyText) as Record<string, unknown>;
}

function createRemoteFleetService(response: { status: number; data: unknown }) {
  const invoke = vi.fn(async () => response);
  return {
    remoteFleetService: { invoke } as unknown as RuntimeAgentIngressRouteDeps['remoteFleetService'],
    invoke,
  };
}

function createHandler(remoteFleetService: RuntimeAgentIngressRouteDeps['remoteFleetService']) {
  return createRuntimeAgentIngressRouteHandler({
    remoteFleetService,
    nowIso: () => '2026-07-11T00:00:00.000Z',
  });
}

describe('RuntimeAgent ingress route', () => {
  it('directly ingresses a JSON heartbeat and maps the authorized headers', async () => {
    const workerResponse = {
      status: 200,
      data: {
        type: 'runtime-agent.heartbeat.response',
        requestId: 'heartbeat-request',
        agentId: 'agent-1',
        resultType: 'recorded',
      },
    };
    const { remoteFleetService, invoke } = createRemoteFleetService(workerResponse);
    const handler = createHandler(remoteFleetService);
    const authorizationCredential = randomUUID();
    const enrollmentCredential = randomUUID();
    const requestPayload = {
      type: 'runtime-agent.heartbeat',
      requestId: 'heartbeat-request',
      agentId: 'agent-1',
    };
    const response = makeResponse();

    await handler(jsonRequest(requestPayload, {
      headers: {
        authorization: `Bearer ${authorizationCredential}`,
        'x-matchaclaw-runtime-agent-ingress-credential': enrollmentCredential,
      },
    }), response);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('ingestRuntimeAgentIngress', {
      rawRequest: requestPayload,
      authorizationCredential,
      enrollmentCredential,
    });
    expect(response.statusCode).toBe(workerResponse.status);
    expect(response.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(responseJson(response)).toEqual(workerResponse.data);
  });

  it('does not pass the enrollment credential for a non-heartbeat ingress request', async () => {
    const workerResponse = {
      status: 200,
      data: {
        type: 'runtime-agent.command.progress.response',
        requestId: 'progress-request',
        agentId: 'agent-1',
        resultType: 'recorded',
      },
    };
    const { remoteFleetService, invoke } = createRemoteFleetService(workerResponse);
    const handler = createHandler(remoteFleetService);
    const authorizationCredential = randomUUID();
    const requestPayload = {
      type: 'runtime-agent.command.progress',
      requestId: 'progress-request',
      agentId: 'agent-1',
      progress: 50,
    };
    const response = makeResponse();

    await handler(jsonRequest(requestPayload, {
      headers: {
        authorization: `Bearer ${authorizationCredential}`,
        'x-matchaclaw-runtime-agent-ingress-credential': randomUUID(),
      },
    }), response);

    expect(invoke).toHaveBeenCalledWith('ingestRuntimeAgentIngress', {
      rawRequest: requestPayload,
      authorizationCredential,
    });
    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual(workerResponse.data);
  });

  it('rejects non-POST methods without invoking the RuntimeAgent worker', async () => {
    const { remoteFleetService, invoke } = createRemoteFleetService({
      status: 200,
      data: {},
    });
    const response = makeResponse();

    await createHandler(remoteFleetService)(makeRequest({
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }), response);

    expect(response.statusCode).toBe(405);
    expect(responseJson(response)).toEqual({
      type: 'runtime-agent.ingress.response',
      requestId: 'invalid-request',
      resultType: 'rejected',
      reason: 'invalid-request',
      message: 'RuntimeAgent ingress request is invalid.',
      receivedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content types without invoking the RuntimeAgent worker', async () => {
    const { remoteFleetService, invoke } = createRemoteFleetService({
      status: 200,
      data: {},
    });
    const response = makeResponse();

    await createHandler(remoteFleetService)(makeRequest({
      headers: { 'content-type': 'text/plain' },
      chunks: [Buffer.from('{}')],
    }), response);

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toMatchObject({
      type: 'runtime-agent.ingress.response',
      resultType: 'rejected',
      reason: 'invalid-request',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without invoking the RuntimeAgent worker', async () => {
    const { remoteFleetService, invoke } = createRemoteFleetService({
      status: 200,
      data: {},
    });
    const response = makeResponse();

    await createHandler(remoteFleetService)(makeRequest({
      headers: { 'content-type': 'application/json' },
      chunks: [Buffer.from('{')],
    }), response);

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toMatchObject({
      type: 'runtime-agent.ingress.response',
      resultType: 'rejected',
      reason: 'invalid-request',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a declared body length above 64 KiB before reading the stream', async () => {
    const { remoteFleetService, invoke } = createRemoteFleetService({
      status: 200,
      data: {},
    });
    const response = makeResponse();

    await createHandler(remoteFleetService)(makeRequest({
      headers: {
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
      chunks: [Buffer.from('{}')],
    }), response);

    expect(response.statusCode).toBe(413);
    expect(responseJson(response)).toMatchObject({
      type: 'runtime-agent.ingress.response',
      resultType: 'rejected',
      reason: 'invalid-request',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a streaming body above 64 KiB before invoking the RuntimeAgent worker', async () => {
    const { remoteFleetService, invoke } = createRemoteFleetService({
      status: 200,
      data: {},
    });
    const response = makeResponse();

    await createHandler(remoteFleetService)(makeRequest({
      headers: { 'content-type': 'application/json' },
      chunks: [Buffer.alloc(64 * 1024), Buffer.from('x')],
    }), response);

    expect(response.statusCode).toBe(413);
    expect(responseJson(response)).toMatchObject({
      type: 'runtime-agent.ingress.response',
      resultType: 'rejected',
      reason: 'invalid-request',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 422,
      reason: 'unsupported-operation',
    },
    {
      status: 409,
      reason: 'command-conflict',
    },
  ])('passes through the worker typed rejection with status $status', async ({ status, reason }) => {
    const workerResponse = {
      status,
      data: {
        type: 'runtime-agent.command.progress.response',
        requestId: 'typed-rejection-request',
        agentId: 'agent-1',
        resultType: 'rejected',
        reason,
        message: 'Worker rejected this request.',
      },
    };
    const { remoteFleetService } = createRemoteFleetService(workerResponse);
    const response = makeResponse();

    await createHandler(remoteFleetService)(jsonRequest({
      type: 'runtime-agent.command.progress',
      requestId: 'typed-rejection-request',
      agentId: 'agent-1',
    }), response);

    expect(response.statusCode).toBe(status);
    expect(responseJson(response)).toEqual(workerResponse.data);
  });

  it('returns a typed 503 without echoing ingress credentials or the raw request when the worker throws', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('worker unavailable');
    });
    const handler = createHandler({ invoke } as unknown as RuntimeAgentIngressRouteDeps['remoteFleetService']);
    const authorizationCredential = randomUUID();
    const enrollmentCredential = randomUUID();
    const idempotencyKey = randomUUID();
    const privateBodyValue = randomUUID();
    const requestPayload = {
      type: 'runtime-agent.heartbeat',
      requestId: 'unavailable-request',
      agentId: 'agent-1',
      metadata: { privateBodyValue },
    };
    const response = makeResponse();

    await handler(jsonRequest(requestPayload, {
      headers: {
        authorization: `Bearer ${authorizationCredential}`,
        'x-matchaclaw-runtime-agent-ingress-credential': enrollmentCredential,
        'x-idempotency-key': idempotencyKey,
      },
    }), response);

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({
      type: 'runtime-agent.heartbeat.response',
      requestId: 'unavailable-request',
      agentId: 'agent-1',
      resultType: 'rejected',
      reason: 'runtime-unavailable',
      message: 'RuntimeAgent ingress is temporarily unavailable.',
      receivedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(response.bodyText).not.toContain(authorizationCredential);
    expect(response.bodyText).not.toContain(enrollmentCredential);
    expect(response.bodyText).not.toContain(idempotencyKey);
    expect(response.bodyText).not.toContain(privateBodyValue);
  });
});
