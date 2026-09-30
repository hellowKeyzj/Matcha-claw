import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';

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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ClawHubSkillSearchTransport {
  return {
    async search(request: unknown): Promise<ClawHubSkillSearchTransportResponse> {
      if (!isSearchRequest(request)) {
        return { status: 400, body: { success: false, error: INVALID_REQUEST } };
      }

      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: SEARCH_SCOPE,
          capability: SEARCH_CAPABILITY,
          subject: SEARCH_SUBJECT,
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSearchSuccess(response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 400
        && (isSearchFailure(response.body, INVALID_REQUEST) || isSearchFailure(response.body, REJECTED))) {
        return { status: 400, body: response.body };
      }
      if (response?.status === 503 && isSearchFailure(response.body, UNAVAILABLE)) {
        return { status: 503, body: response.body };
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
  error: ClawHubSkillSearchFailure['error'],
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
  return isSafeNonNegativeInteger(value);
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !value.includes('\0')
    && (allowEmpty || value.trim().length > 0);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
