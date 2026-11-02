import type { BrowserInterceptRule } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import type { IabFetchResolution } from './contracts';

/** Admitted static rules run synchronously on their live Main-owned lease. */
export function resolveIntercept(rules: readonly BrowserInterceptRule[], params: IabJsonObject): IabFetchResolution {
  const request = params.request as IabJsonObject;
  const budget = { remaining: 1_000_000 };
  const rule = rules.find((candidate) => matchUrl(String(request.url), candidate, budget));
  if (!rule || rule.action === 'continue') return { method: 'Fetch.continueRequest', params: {} };
  if (rule.action === 'block') return { method: 'Fetch.failRequest', params: { errorReason: 'BlockedByClient' } };
  const headers = { ...(rule.headers ?? {}), ...(rule.contentType ? { 'Content-Type': rule.contentType } : {}) };
  if (rule.action === 'mock') return { method: 'Fetch.fulfillRequest', params: { responseCode: rule.status ?? 200, responseHeaders: headerEntries(headers), body: Buffer.from(rule.body ?? '').toString('base64') } };
  return { method: 'Fetch.continueRequest', params: { ...(rule.method ? { method: rule.method } : {}), ...(rule.headers ? { headers: headerEntries(rule.headers) } : {}) } };
}

function headerEntries(headers: Record<string, string>): { name: string; value: string }[] {
  const entries: { name: string; value: string }[] = [], seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); entries.push({ name, value }); }
  }
  return entries;
}

function matchUrl(url: string, rule: BrowserInterceptRule, budget: { remaining: number }): boolean {
  if (url.length > 65536 || budget.remaining <= 0) return false;
  const pattern = rule.pattern;
  if (rule.match !== 'glob') {
    budget.remaining -= url.length + pattern.length;
    return budget.remaining >= 0 && url.includes(pattern);
  }
  let cursor = 0, offset = 0, star = -1, retry = 0;
  while (offset < url.length) {
    if (--budget.remaining < 0) return false;
    if (pattern[cursor] === '?' || pattern[cursor] === url[offset]) { cursor++; offset++; }
    else if (pattern[cursor] === '*') { star = cursor++; retry = offset; }
    else if (star >= 0) { cursor = star + 1; offset = ++retry; }
    else return false;
  }
  while (pattern[cursor] === '*') { if (--budget.remaining < 0) return false; cursor++; }
  return cursor === pattern.length;
}
