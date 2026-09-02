import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceMediaTransport } from '../../electron/main/runtime-host-delivery/transport/workspace/media';

const port = 34_107;
const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const prepareRequest = {
  id: 'workspace.media',
  operationId: 'media.prepare',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    relativePath: 'docs/image.png',
    mimeType: 'image/png',
  },
} as const;

const resolveRequest = {
  id: 'workspace.media',
  operationId: 'media.resolve',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    reference: 'media_0123456789abcdef0123456789abcdef',
  },
} as const;

const thumbnailRequest = {
  id: 'workspace.media',
  operationId: 'media.thumbnail',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    relativePath: 'docs/image.png',
    mimeType: 'image/png',
  },
} as const;

const gatewayThumbnailRequest = {
  id: 'workspace.media',
  operationId: 'media.thumbnail',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    gatewayUrl: 'https://gateway.local/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full',
    mimeType: 'image/svg+xml',
    agentId: 'main',
  },
} as const;

const thumbnailsRequest = {
  id: 'workspace.media',
  operationId: 'media.thumbnails',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    paths: [{ key: 'docs/image.png', relativePath: 'docs/image.png', mimeType: 'image/png' }],
  },
} as const;

const stagePathsRequest = {
  id: 'workspace.media',
  operationId: 'media.stagePaths',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    paths: [{ key: 'docs/image.png', relativePath: 'docs/image.png', mimeType: 'image/png' }],
  },
} as const;

const stageBufferRequest = {
  id: 'workspace.media',
  operationId: 'media.stageBuffer',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-media' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    base64: 'aGVsbG8=',
    fileName: 'hello.txt',
    mimeType: 'text/plain',
  },
} as const;

const validPrepareResponse = {
  reference: 'media_0123456789abcdef0123456789abcdef',
  name: 'image.png',
  mimeType: 'image/png',
  size: 1_024,
  preview: 'preview',
};
const validThumbnailResponse = { preview: 'preview', fileSize: 1_024 };
const validSvgThumbnailResponse = { preview: 'data:image/svg+xml;base64,PHN2Zw==', fileSize: 6 };
const validThumbnailsResponse = {
  'docs/image.png': validThumbnailResponse,
};
const validStagePathsResponse = [validPrepareResponse];

const unavailable = {
  success: false,
  error: 'Workspace media is unavailable',
} as const;

const sizeLimit = 50 * 1024 * 1024;

function createTransport(
  signDecision: ReturnType<typeof vi.fn>,
  fetcher: ReturnType<typeof vi.fn>,
) {
  return createWorkspaceMediaTransport(
    { verificationKey: 'public', signDecision },
    port,
    fetcher,
  );
}

describe('Electron Main workspace media transport', () => {
  it('signs and forwards all six operations to the fixed endpoint', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => validPrepareResponse })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: 'cmVzb2x2ZWQgYnl0ZXM=' }) })
      .mockResolvedValueOnce({ status: 200, json: async () => validThumbnailResponse })
      .mockResolvedValueOnce({ status: 200, json: async () => validThumbnailsResponse })
      .mockResolvedValueOnce({ status: 200, json: async () => validStagePathsResponse })
      .mockResolvedValueOnce({ status: 200, json: async () => validPrepareResponse });
    const transport = createTransport(signDecision, fetcher);

    await expect(transport.execute(prepareRequest)).resolves.toEqual({ status: 200, body: validPrepareResponse });
    await expect(transport.execute(resolveRequest)).resolves.toEqual({ status: 200, body: { data: 'cmVzb2x2ZWQgYnl0ZXM=' } });
    await expect(transport.execute(thumbnailRequest)).resolves.toEqual({ status: 200, body: validThumbnailResponse });
    await expect(transport.execute(thumbnailsRequest)).resolves.toEqual({ status: 200, body: validThumbnailsResponse });
    await expect(transport.execute(stagePathsRequest)).resolves.toEqual({ status: 200, body: validStagePathsResponse });
    await expect(transport.execute(stageBufferRequest)).resolves.toEqual({ status: 200, body: validPrepareResponse });

    expect(signDecision).toHaveBeenCalledTimes(6);
    expect(signDecision.mock.calls.map(([decision]) => decision.capability)).toEqual([
      'media.prepare', 'media.resolve', 'media.thumbnail', 'media.thumbnails', 'media.stagePaths', 'media.stageBuffer',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse((options as RequestInit).body as string).operationId)).toEqual([
      'media.prepare', 'media.resolve', 'media.thumbnail', 'media.thumbnails', 'media.stagePaths', 'media.stageBuffer',
    ]);
  });

  it('forwards outgoing Gateway SVG thumbnail requests', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => validSvgThumbnailResponse });
    const transport = createTransport(signDecision, fetcher);

    await expect(transport.execute(gatewayThumbnailRequest)).resolves.toEqual({ status: 200, body: validSvgThumbnailResponse });

    expect(signDecision).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.input).toEqual(gatewayThumbnailRequest.input);
  });

  const invalidRequests: Array<[string, unknown]> = [
    ['empty relative path', { ...prepareRequest, input: { ...prepareRequest.input, relativePath: '' } }],
    ['relative path traversal', { ...prepareRequest, input: { ...prepareRequest.input, relativePath: 'docs/../secret.png' } }],
    ['unix absolute path', { ...prepareRequest, input: { ...prepareRequest.input, relativePath: '/private/secret.png' } }],
    ['windows absolute path', { ...prepareRequest, input: { ...prepareRequest.input, relativePath: 'C:/private/secret.png' } }],
    ['top-level unknown field', { ...prepareRequest, privatePath: 'C:/private/root' }],
    ['scope unknown field', { ...prepareRequest, scope: { ...prepareRequest.scope, extra: 'unknown' } }],
    ['target unknown field', { ...prepareRequest, target: { ...prepareRequest.target, extra: 'unknown' } }],
    ['prepare input unknown field', { ...prepareRequest, input: { ...prepareRequest.input, extra: 'unknown' } }],
    ['resolve input unknown field', { ...resolveRequest, input: { ...resolveRequest.input, extra: 'unknown' } }],
    ['thumbnail input unknown field', { ...thumbnailRequest, input: { ...thumbnailRequest.input, extra: 'unknown' } }],
    ['thumbnails path unknown field', {
      ...thumbnailsRequest,
      input: { ...thumbnailsRequest.input, paths: [{ ...thumbnailsRequest.input.paths[0], stagedPath: 'C:/private' }] },
    }],
    ['stage paths absolute path', {
      ...stagePathsRequest,
      input: { ...stagePathsRequest.input, paths: [{ ...stagePathsRequest.input.paths[0], relativePath: 'C:/private/image.png' }] },
    }],
    ['stage paths gateway path', {
      ...stagePathsRequest,
      input: {
        ...stagePathsRequest.input,
        paths: [{ key: 'remote-image', gatewayUrl: 'api/chat/media/outgoing/agent/message/image.png', mimeType: 'image/png', agentId: 'agent' }],
      },
    }],
    ['stage buffer non-canonical base64', { ...stageBufferRequest, input: { ...stageBufferRequest.input, base64: 'aGVsbG8' } }],
    ['stage buffer oversized base64', { ...stageBufferRequest, input: { ...stageBufferRequest.input, base64: 'A'.repeat(Math.ceil((sizeLimit + 1) / 3) * 4) } }],
    ['reference with uppercase prefix', { ...resolveRequest, input: { ...resolveRequest.input, reference: 'Media_0123456789abcdef0123456789abcdef' } }],
    ['reference with uppercase hex', { ...resolveRequest, input: { ...resolveRequest.input, reference: 'media_0123456789ABCDEF0123456789abcdef' } }],
    ['reference with the wrong hex length', { ...resolveRequest, input: { ...resolveRequest.input, reference: `media_${'a'.repeat(31)}` } }],
    ['reference with the wrong prefix', { ...resolveRequest, input: { ...resolveRequest.input, reference: 'ref_0123456789abcdef0123456789abcdef' } }],
  ];

  it.each(invalidRequests)('rejects %s before signing or fetching', async (_name, invalidRequest) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTransport(signDecision, fetcher);

    await expect(transport.execute(invalidRequest)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a prepare response at the 50 MiB boundary and rejects larger responses', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ...validPrepareResponse, size: sizeLimit }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ...validPrepareResponse, size: sizeLimit + 1 }) });
    const transport = createTransport(signDecision, fetcher);

    await expect(transport.execute(prepareRequest)).resolves.toEqual({
      status: 200,
      body: { ...validPrepareResponse, size: sizeLimit },
    });
    await expect(transport.execute(prepareRequest)).resolves.toEqual({ status: 503, body: unavailable });
  });

  const invalidPrepareResponses: Array<[string, unknown]> = [
    ['unknown field', { ...validPrepareResponse, extra: 'unknown' }],
    ['invalid reference', { ...validPrepareResponse, reference: 'media_0123456789abcdef0123456789ABCDEf' }],
    ['missing preview', {
      reference: validPrepareResponse.reference,
      name: validPrepareResponse.name,
      mimeType: validPrepareResponse.mimeType,
      size: validPrepareResponse.size,
    }],
    ['negative size', { ...validPrepareResponse, size: -1 }],
  ];

  it.each(invalidPrepareResponses)('projects malformed 200 prepare shape %s as unavailable', async (_name, body) => {
    const transport = createTransport(
      vi.fn().mockReturnValue('signed-decision'),
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.execute(prepareRequest)).resolves.toEqual({ status: 503, body: unavailable });
  });

  it('accepts canonical resolve data without applying the prepare size limit', async () => {
    const data = Buffer.alloc(sizeLimit + 1).toString('base64');
    const transport = createTransport(
      vi.fn().mockReturnValue('signed-decision'),
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ data }) }),
    );

    const response = await transport.execute(resolveRequest);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data });
  });

  const invalidResolveResponses: Array<[string, unknown]> = [
    ['missing data', {}],
    ['non-string data', { data: { bytes: 'private' } }],
    ['unknown field', { data: 'resolved bytes', extra: 'unknown' }],
  ];

  it.each(invalidResolveResponses)('projects malformed 200 resolve shape %s as unavailable', async (_name, body) => {
    const transport = createTransport(
      vi.fn().mockReturnValue('signed-decision'),
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.execute(resolveRequest)).resolves.toEqual({ status: 503, body: unavailable });
  });

  it('preserves a sealed 422 failure', async () => {
    const body = { success: false, error: 'Workspace media reference is invalid' };
    const transport = createTransport(
      vi.fn().mockReturnValue('signed-decision'),
      vi.fn().mockResolvedValue({ status: 422, json: async () => body }),
    );

    await expect(transport.execute(resolveRequest)).resolves.toEqual({ status: 422, body });
  });

  it('projects malformed responses and native rejections without leaking path or secret details', async () => {
    const privateDetails = 'C:/workspace/root/private-secret-token';
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ error: privateDetails }) })
      .mockRejectedValueOnce(new Error(`native failure at ${privateDetails}`));
    const transport = createTransport(
      vi.fn().mockReturnValue('signed-decision'),
      fetcher,
    );

    const malformed = await transport.execute(prepareRequest);
    const rejected = await transport.execute(resolveRequest);

    expect(malformed).toEqual({ status: 503, body: unavailable });
    expect(rejected).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(malformed)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(malformed)).not.toContain('private-secret-token');
    expect(JSON.stringify(rejected)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(rejected)).not.toContain('private-secret-token');
  });
});
