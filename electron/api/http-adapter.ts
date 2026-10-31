import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RendererSessionObservationRegistry } from '../main/sessions/observations';
import { SESSION_PAGE_HEADER } from '../main/sessions/observations';
import { HostApiBodyTooLarge, parseJsonBytes, type HostApiRequest, type HostApiResponse } from './execution';

export function createHttpApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  observers: RendererSessionObservationRegistry,
): Readonly<{ request: HostApiRequest; dispose(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', closed);
  if (req.aborted || res.destroyed) abort();

  const readBytes = async (maximum?: number, drainOnError = false): Promise<Uint8Array> => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (maximum !== undefined && Number(req.headers['content-length']) > maximum) throw new HostApiBodyTooLarge();
      for await (const chunk of req.iterator({ destroyOnReturn: !drainOnError })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (maximum !== undefined && size > maximum) throw new HostApiBodyTooLarge();
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (drainOnError) req.resume();
      throw error;
    }
  };
  return {
    request: {
      method: req.method ?? '',
      headers: req.headers,
      signal: controller.signal,
      sessionPage: observers.resolve(req.headers[SESSION_PAGE_HEADER.toLowerCase()]),
      readBytes,
      readJson: async <T>() => parseJsonBytes<T>(await readBytes()),
    },
    dispose() {
      req.off('aborted', abort);
      res.off('close', closed);
    },
  };
}

export function writeHttpApiResponse(res: ServerResponse, response: HostApiResponse): void {
  res.statusCode = response.status;
  if (response.kind === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
    res.end(response.serializedBody);
  } else {
    res.setHeader('Content-Type', response.contentType);
    res.end(response.body);
  }
}
