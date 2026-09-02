import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const ENDPOINT = '/api/clawhub/search';
const SEARCH_SCOPE = 'skills:search';
const SEARCH_CAPABILITY = 'clawhubSkill.search';
const SEARCH_SUBJECT = 'clawhub-skill-search';
const INVALID_REQUEST = 'ClawHub search request is invalid';
const REJECTED = 'ClawHub search was rejected';
const UNAVAILABLE = 'ClawHub search is unavailable';
const MAX_QUERY_BYTES = 256;
const MAX_RESULTS = 50;

export type ClawHubSkillSearchRequest = Readonly<{
  query: string;
}>;

export type ClawHubMarketplaceSkill = Readonly<{
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  stars?: number;
}>;

export type ClawHubSkillSearchSuccess = Readonly<{
  success: true;
  results: ClawHubMarketplaceSkill[];
}>;

export type ClawHubSkillSearchFailure = Readonly<{
  success: false;
  error: typeof INVALID_REQUEST | typeof REJECTED | typeof UNAVAILABLE;
}>;

export type ClawHubSkillSearchResult = ClawHubSkillSearchSuccess | ClawHubSkillSearchFailure;

export type ClawHubSkillSearchTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: ClawHubSkillSearchResult;
}>;

export interface ClawHubSkillSearchTransport {
  search(request: unknown): Promise<ClawHubSkillSearchTransportResponse>;
}

export function createClawHubSkillSearchTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ClawHubSkillSearchTransport {
  return {
    async search(request: unknown): Promise<ClawHubSkillSearchTransportResponse> {
      if (!isSearchRequest(request)) {
        return { status: 400, body: { success: false, error: INVALID_REQUEST } };
      }

      try {
        const response = await fetcher(`http://127.0.0.1:${port}${ENDPOINT}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: SEARCH_SCOPE,
              capability: SEARCH_CAPABILITY,
              subject: SEARCH_SUBJECT,
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSearchSuccess(body)) {
          return { status: 200, body };
        }
        if (response.status === 400
          && (isSearchFailure(body, INVALID_REQUEST) || isSearchFailure(body, REJECTED))) {
          return { status: 400, body };
        }
        if (response.status === 503 && isSearchFailure(body, UNAVAILABLE)) {
          return { status: 503, body };
        }
      } catch {
        // Public delivery deliberately redacts loopback and host failures.
      }

      return { status: 503, body: { success: false, error: UNAVAILABLE } };
    },
  };
}

function isSearchRequest(value: unknown): value is ClawHubSkillSearchRequest {
  return isRecord(value)
    && hasExactKeys(value, ['query'])
    && isBoundedText(value.query, MAX_QUERY_BYTES, true);
}

function isSearchSuccess(value: unknown): value is ClawHubSkillSearchSuccess {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'results'])
    && value.success === true
    && Array.isArray(value.results)
    && value.results.length <= MAX_RESULTS
    && value.results.every(isMarketplaceSkill);
}

function isSearchFailure(
  value: unknown,
  error: typeof REJECTED | typeof UNAVAILABLE,
): value is ClawHubSkillSearchFailure {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === error;
}

function isMarketplaceSkill(value: unknown): value is ClawHubMarketplaceSkill {
  return isRecord(value)
    && hasOnlyKeys(value, ['slug', 'name', 'description', 'version', 'author', 'downloads', 'stars'])
    && Object.hasOwn(value, 'slug')
    && Object.hasOwn(value, 'name')
    && Object.hasOwn(value, 'description')
    && Object.hasOwn(value, 'version')
    && isSlug(value.slug)
    && isBoundedText(value.name, 256, false)
    && isBoundedText(value.description, 8_192, true)
    && isBoundedText(value.version, 128, false)
    && (value.author === undefined || isBoundedText(value.author, 256, false))
    && (value.downloads === undefined || isOptionalCount(value.downloads))
    && (value.stars === undefined || isOptionalCount(value.stars));
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isOptionalCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !value.includes('\0')
    && (allowEmpty || value.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
