import type { DocumentResource } from './model';
import { OfficeError } from '../errors';

export function textBytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

export async function checkText(source: string, resources: readonly DocumentResource[]): Promise<{ issues: { code: string; message: string }[] }> {
  const sources: string[] = [];
  const { marked } = await import('marked');
  const tokens = marked.lexer(source);
  marked.walkTokens(tokens, (token) => {
    if (token.type === 'image') sources.push(token.href);
  });
  const paths = new Set(resources.map((resource) => resource.path));
  const issues: { code: string; message: string }[] = [];
  for (const src of new Set(sources)) {
    if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) continue;
    let path = src.split(/[?#]/, 1)[0];
    try { path = decodeURIComponent(path); } catch { /* Keep literal percent filenames. */ }
    path = path.replace(/^\.\//, '');
    if (!paths.has(path)) issues.push({ code: 'missing_resource', message: `Image resource is missing: ${src}.` });
  }
  return { issues };
}

export function sourceText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8_000_000) {
    throw new OfficeError('invalid_request', 'source must be a string of at most 8000000 characters.');
  }
  return value;
}
