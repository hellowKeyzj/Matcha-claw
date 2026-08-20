import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;

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
  status: 200 | 400 | 422 | 503;
  body: ClawHubSkillInstallResult;
}>;

export interface ClawHubSkillInstallTransport {
  install(request: unknown): Promise<ClawHubSkillInstallTransportResponse>;
}

export function createClawHubSkillInstallTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ClawHubSkillInstallTransport {
  const url = `http://127.0.0.1:${port}/api/clawhub/skills/install`;
  return {
    async install(request: unknown): Promise<ClawHubSkillInstallTransportResponse> {
      if (!isInstallRequest(request)) {
        return { status: 400, body: rejectedResultFor(request) };
      }

      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/clawhub/skills/install',
              scope: 'skills:install',
              capability: 'clawhubSkill.install',
              subject: 'clawhub-skill-install',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isInstallResult(body, request.slug)) {
          return { status: 200, body };
        }
        if (response.status === 400 && isInstallResult(body, request.slug) && body.outcome === 'rejected') {
          return { status: 400, body };
        }
        if (response.status === 422 && isInstallResult(body, request.slug) && body.outcome === 'rejected') {
          return { status: 422, body };
        }
      } catch {
        // Public delivery deliberately redacts loopback and host failures.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
