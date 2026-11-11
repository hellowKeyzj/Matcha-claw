import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const DOCS_PARSE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1.5 * 1024 * 1024 * 1024;
const HANDOFF_BYTES = 1024 * 1024 * 1024;
const TTL = 60_000;

type Upload = { path: string; size: number; ready: boolean; writing: boolean; timer: ReturnType<typeof setTimeout> };
type Handoff = { bytes: Buffer; timer: ReturnType<typeof setTimeout> };

/** Editor-owned binary transport; native paths never cross the page boundary. */
export function createDocsResources(storagePath: string, media: (hash: string, part: string) => Promise<{ bytes: Buffer; mime: string } | null>) {
  const token = randomBytes(32).toString('hex');
  const uploads = new Map<string, Upload>();
  const handoffs = new Map<string, Handoff>();
  const active = new Set<Promise<void>>();
  const consuming = new Set<Promise<unknown>>();
  const controller = new AbortController();
  let pendingBytes = 0;
  let closed = false;
  let stopping: Promise<void> | undefined;
  let baseUrl = '';
  let directory: Promise<string> | undefined;
  const server = createServer({ requestTimeout: TTL, headersTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => {
    const operation = serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(controller.signal.aborted ? 410 : 400);
      response.end();
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  const ready = new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Docs resource listener unavailable.'));
      baseUrl = `http://127.0.0.1:${address.port}/${token}/`;
      resolve(baseUrl);
    });
  });

  function transferDirectory(): Promise<string> {
    directory ??= (async () => {
      const root = join(storagePath, 'docs', 'transfers');
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(join(root, 'editor-'));
    })();
    return directory;
  }

  function dropHandoff(id: string): void {
    const value = handoffs.get(id);
    if (!value) return;
    clearTimeout(value.timer);
    pendingBytes -= value.bytes.length;
    handoffs.delete(id);
  }

  async function dropUpload(id: string): Promise<void> {
    const value = uploads.get(id);
    if (!value) return;
    uploads.delete(id);
    clearTimeout(value.timer);
    await rm(value.path, { force: true });
  }

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await ready;
    const host = new URL(baseUrl).host;
    const origin = request.headers.origin;
    const image = request.method === 'GET' && request.headers['sec-fetch-dest'] === 'image' && origin === undefined;
    if (closed || request.headers.host !== host || request.headers.cookie || (origin !== 'null' && !image)
      || !request.url?.startsWith(`/${token}/`)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', 'null');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') {
      if (!['GET', 'POST'].includes(String(request.headers['access-control-request-method']))) { response.writeHead(405).end(); return; }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      response.writeHead(204).end();
      return;
    }
    const relative = request.url.slice(token.length + 2);
    const uploadId = /^upload\/([a-f0-9-]{36})$/.exec(relative)?.[1];
    if (request.method === 'POST' && uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.ready || upload.writing || request.headers['content-type'] !== 'application/octet-stream') { response.writeHead(409).end(); return; }
      upload.writing = true;
      let length = 0;
      const file = await open(upload.path, 'wx', 0o600);
      try {
        for await (const chunk of request) {
          controller.signal.throwIfAborted();
          length += chunk.length;
          if (length > upload.size || length > MAX_SOURCE_BYTES) throw new Error('Docs upload exceeds its declared size.');
          let offset = 0;
          while (offset < chunk.length) offset += (await file.write(chunk, offset)).bytesWritten;
        }
        if (length !== upload.size || !uploads.has(uploadId)) throw new Error('Incomplete Docs upload.');
        upload.ready = true;
        response.writeHead(204).end();
      } catch (error) {
        await file.close();
        await dropUpload(uploadId);
        throw error;
      }
      await file.close();
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const handoffId = /^handoff\/([a-f0-9-]{36})$/.exec(relative)?.[1];
    if (handoffId) {
      const value = handoffs.get(handoffId);
      if (!value) { response.writeHead(404).end(); return; }
      dropHandoff(handoffId);
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', value.bytes.length);
      response.end(value.bytes);
      return;
    }
    const match = /^media\/([a-f0-9]{64})\/(.+)$/.exec(relative);
    if (!match) { response.writeHead(404).end(); return; }
    const part = match[2]!.split('/').map(decodeURIComponent).join('/');
    const result = await media(match[1]!, part);
    controller.signal.throwIfAborted();
    if (!result) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', result.mime);
    response.setHeader('Content-Length', result.bytes.length);
    response.end(result.bytes);
  }

  return {
    ready,
    signal: controller.signal,
    async upload(size: number): Promise<{ id: string; url: string }> {
      if (closed || !Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_BYTES) throw new Error('Invalid Docs upload size.');
      const id = randomUUID();
      const path = join(await transferDirectory(), id);
      controller.signal.throwIfAborted();
      if (uploads.size) throw new Error('A Docs upload is already pending.');
      const timer = setTimeout(() => { void dropUpload(id); }, TTL);
      timer.unref?.();
      uploads.set(id, { path, size, ready: false, writing: false, timer });
      return { id, url: `${await ready}upload/${id}` };
    },
    async consume<T>(id: string, action: (path: string) => Promise<T>): Promise<T> {
      const upload = uploads.get(id);
      if (!upload?.ready || closed) throw new Error('Docs upload is unavailable.');
      upload.ready = false;
      clearTimeout(upload.timer);
      const operation = action(upload.path);
      consuming.add(operation);
      try { return await operation; }
      finally { consuming.delete(operation); uploads.delete(id); await rm(upload.path, { force: true }); }
    },
    async retain(bytes: Buffer): Promise<string> {
      const path = join(await transferDirectory(), randomUUID());
      controller.signal.throwIfAborted();
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(bytes); } finally { await file.close(); }
      return path;
    },
    async handoff(bytes: Buffer): Promise<string> {
      if (closed || bytes.length > DOCS_PARSE_BYTES) throw new Error('Docs parsing input exceeds 512 MiB.');
      while (handoffs.size >= 8 || pendingBytes + bytes.length > HANDOFF_BYTES) dropHandoff(handoffs.keys().next().value!);
      const id = randomUUID();
      const timer = setTimeout(() => dropHandoff(id), TTL);
      timer.unref?.();
      handoffs.set(id, { bytes, timer });
      pendingBytes += bytes.length;
      return `${await ready}handoff/${id}`;
    },
    close(): Promise<void> {
      stopping ??= (async () => {
        closed = true;
        controller.abort();
        await ready.catch(() => {});
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...active, ...consuming]);
        await stopped;
        for (const id of handoffs.keys()) dropHandoff(id);
        await Promise.all([...uploads.keys()].map(dropUpload));
        if (directory) await rm(await directory, { recursive: true, force: true });
      })();
      return stopping;
    }
  };
}
