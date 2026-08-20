import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const EXPORT_ENDPOINT = '/api/subagents/skill-bundles/export';
const IMPORT_ENDPOINT = '/api/subagents/skill-bundles/import';

export type SkillBundle = Readonly<{
  skillKey: string;
  files: ReadonlyArray<Readonly<{ path: string; content: string }>>;
}>;

export type SkillBundleTransferResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown';
  skillBundles?: readonly SkillBundle[];
}>;

export type SkillBundleTransportResponse = Readonly<{
  status: 200 | 400 | 401 | 503;
  body: SkillBundleTransferResult;
}>;

export interface SkillBundleTransport {
  exportBundles(request: unknown): Promise<SkillBundleTransportResponse>;
  importBundles(request: unknown): Promise<SkillBundleTransportResponse>;
}

export function createSkillBundleTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): SkillBundleTransport {
  return {
    exportBundles: async (request) => transfer(
      issuer,
      fetcher,
      port,
      EXPORT_ENDPOINT,
      'export',
      request,
    ),
    importBundles: async (request) => transfer(
      issuer,
      fetcher,
      port,
      IMPORT_ENDPOINT,
      'import',
      request,
    ),
  };
}

async function transfer(
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  port: number,
  endpoint: string,
  operation: 'export' | 'import',
  request: unknown,
): Promise<SkillBundleTransportResponse> {
  if (!isRequest(operation, request)) return rejectedResponse();

  try {
    const response = await fetcher(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint,
          scope: 'subagents:skill-bundles',
          capability: 'subagentSkillBundles.transfer',
          subject: 'subagent-skill-bundles',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json();
    if (response.status === 200 && isResult(operation, body)) return { status: 200, body };
    if (response.status === 400 && isRejectedResult(body)) return { status: 400, body };
    if (response.status === 401 && isUnknownResult(body)) return { status: 401, body };
  } catch {
    // Public delivery deliberately redacts loopback and host failures.
  }

  return { status: 503, body: { outcome: 'unknown' } };
}

function isRequest(operation: 'export' | 'import', value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (operation === 'export') {
    return hasExactKeys(value, ['skillKeys']) && Array.isArray(value.skillKeys) && value.skillKeys.every(isSkillKey);
  }
  return hasExactKeys(value, ['skillBundles']) && Array.isArray(value.skillBundles) && value.skillBundles.every(isBundle);
}

function isResult(operation: 'export' | 'import', value: unknown): value is SkillBundleTransferResult {
  if (!isRecord(value)) return false;
  if (operation === 'export') {
    return value.outcome === 'accepted'
      && hasExactKeys(value, ['outcome', 'skillBundles'])
      && Array.isArray(value.skillBundles)
      && value.skillBundles.every(isBundle);
  }
  return isOutcome(value.outcome) && hasExactKeys(value, ['outcome']);
}

function isRejectedResult(value: unknown): value is SkillBundleTransferResult {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'rejected';
}

function isUnknownResult(value: unknown): value is SkillBundleTransferResult {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'unknown';
}

function isBundle(value: unknown): value is SkillBundle {
  return isRecord(value)
    && hasExactKeys(value, ['skillKey', 'files'])
    && isSkillKey(value.skillKey)
    && Array.isArray(value.files)
    && value.files.every((file) => isRecord(file)
      && hasExactKeys(file, ['path', 'content'])
      && isFilePath(file.path)
      && typeof file.content === 'string');
}

function isSkillKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 96;
}

function isFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isOutcome(value: unknown): value is SkillBundleTransferResult['outcome'] {
  return value === 'accepted' || value === 'rejected' || value === 'unknown';
}

function rejectedResponse(): SkillBundleTransportResponse {
  return { status: 400, body: { outcome: 'rejected' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
