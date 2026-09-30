import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { isSkillsCallReceipt, type SkillsCallReceipt } from './management';

const ENDPOINT = '/api/clawhub/skills/install';
const INSTALL_SCOPE = 'skills:install';
const INSTALL_CAPABILITY = 'clawhubSkill.install';
const INSTALL_SUBJECT = 'clawhub-skill-install';

export type ClawHubSkillInstallRequest = Readonly<{
  slug: string;
  version?: string;
  force: boolean;
}>;

export type ClawHubSkillInstallResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown';
  slug: string;
  version?: string;
}>;

export type ClawHubSkillInstallTransportResponse = Readonly<{
  status: 400 | 422 | 503;
  body: ClawHubSkillInstallResult;
}> | Readonly<{ status: 202; body: SkillsCallReceipt }>;

export interface ClawHubSkillInstallTransport {
  install(request: unknown): Promise<ClawHubSkillInstallTransportResponse>;
}

export function createClawHubSkillInstallTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ClawHubSkillInstallTransport {
  return {
    async install(request: unknown): Promise<ClawHubSkillInstallTransportResponse> {
      if (!isInstallRequest(request)) {
        return { status: 400, body: rejectedResultFor(request) };
      }

      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: INSTALL_SCOPE,
          capability: INSTALL_CAPABILITY,
          subject: INSTALL_SUBJECT,
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 202 && isSkillsCallReceipt(response.body)) {
        return { status: 202, body: response.body };
      }
      if (response?.status === 400 && isInstallResult(response.body, request.slug) && response.body.outcome === 'rejected') {
        return { status: 400, body: response.body };
      }
      if (response?.status === 422 && isInstallResult(response.body, request.slug) && response.body.outcome === 'rejected') {
        return { status: 422, body: response.body };
      }

      return { status: 503, body: { outcome: 'unknown', slug: request.slug } };
    },
  };
}

function isInstallRequest(value: unknown): value is ClawHubSkillInstallRequest {
  return isRecord(value)
    && hasExactKeys(value, value.version === undefined ? ['slug', 'force'] : ['slug', 'version', 'force'])
    && isSlug(value.slug)
    && (value.version === undefined || isVersion(value.version))
    && typeof value.force === 'boolean';
}

function isInstallResult(value: unknown, requestedSlug: string): value is ClawHubSkillInstallResult {
  return isRecord(value)
    && hasExactKeys(value, value.version === undefined ? ['outcome', 'slug'] : ['outcome', 'slug', 'version'])
    && (value.outcome === 'accepted' || value.outcome === 'rejected' || value.outcome === 'unknown')
    && value.slug === requestedSlug
    && (value.version === undefined || isVersion(value.version));
}

function rejectedResultFor(value: unknown): ClawHubSkillInstallResult {
  return {
    outcome: 'rejected',
    slug: isRecord(value) && isSlug(value.slug) ? value.slug : 'invalid',
  };
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && Array.from(value).every((character) => character.codePointAt(0)! >= 0x20 && character.codePointAt(0)! !== 0x7f);
}
