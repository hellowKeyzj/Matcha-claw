export function sendJson(res: any, statusCode: number, payload: unknown): void {
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

export function resolveDeletedPath(pathname: string): string {
  return pathname.endsWith('.jsonl')
    ? pathname.replace(/\.jsonl$/, '.deleted.jsonl')
    : `${pathname}.deleted`;
}
