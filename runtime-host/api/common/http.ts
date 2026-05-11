export interface RuntimeHttpResponsePort {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(payload: string): void;
}

export function sendJson(res: RuntimeHttpResponsePort, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function normalizeRoutePath(route: unknown): string {
  return String(route || '').split('?')[0];
}

export function parseRouteUrl(route: unknown): URL {
  const normalized = typeof route === 'string' && route.startsWith('/')
    ? route
    : `/${String(route || '')}`;
  return new URL(normalized, 'http://runtime-host.local');
}
