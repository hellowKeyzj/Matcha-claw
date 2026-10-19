import { request as httpRequest } from 'node:http';
import { Readable, addAbortSignal } from 'node:stream';

type LoopbackHttpCallbacks = Readonly<{
  uploadFinished?: () => void;
  responseStarted?: () => void;
}>;

// Node fetch limits response headers to 300s even when its AbortSignal allows longer.
export function fetchLoopbackHttp(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  callbacks?: LoopbackHttpCallbacks,
): Promise<Response> {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('Loopback HTTP requires a URL.');
  }
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new TypeError('Loopback HTTP requires a local HTTP URL.');
  }
  if (init?.body != null && typeof init.body !== 'string') {
    throw new TypeError('Loopback HTTP requires a string body.');
  }
  const body = init?.body ?? undefined;
  const signal = init?.signal ?? undefined;
  return new Promise((resolve, reject) => {
    let receivedResponse = false;
    const request = httpRequest(url, {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal,
    }, (incoming) => {
      receivedResponse = true;
      callbacks?.responseStarted?.();
      if (signal) addAbortSignal(signal, incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode,
        headers,
      }));
    });
    request.once('finish', () => {
      if (!receivedResponse) callbacks?.uploadFinished?.();
    });
    request.once('error', reject);
    request.end(body);
  });
}
