import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isBoundedText, isRecord, sendLoopbackJson } from './client';

const AUTHORIZE_PACKAGE_ENDPOINT = '/api/sealed-resource/authorize-package';

type SealedResourceAuthorizationStatus = 200 | 400 | 503;

export type SealedResourceAuthorizePackageRequest = Readonly<{
  packageSha256: string;
  authorizationKey: string;
  leaseExpiresAt?: string;
}>;

export type SealedResourceAuthorizationResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown';
  reason?: string;
  error?: string;
}>;

export type SealedResourceAuthorizationResponse = Readonly<{
  status: SealedResourceAuthorizationStatus;
  body: SealedResourceAuthorizationResult;
}>;

export interface SealedResourceAuthorizationTransport {
  authorizePackage(request: unknown): Promise<SealedResourceAuthorizationResponse>;
}

export function createSealedResourceAuthorizationTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SealedResourceAuthorizationTransport {
  return {
    authorizePackage: (request) => authorizePackage(issuer, runtimeHostTransportPort, fetcher, request),
  };
}

async function authorizePackage(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  request: unknown,
): Promise<SealedResourceAuthorizationResponse> {
  if (!isAuthorizePackageRequest(request)) return rejectedResponse();

  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: AUTHORIZE_PACKAGE_ENDPOINT,
    issuer,
    decision: {
      endpoint: AUTHORIZE_PACKAGE_ENDPOINT,
      scope: 'sealed-resource:package',
      capability: 'sealedResource.authorizePackage',
      subject: 'sealed-resource-keyring',
    },
    method: 'POST',
    fetcher,
    body: request,
  });
  if (response?.status === 200 && isAcceptedResult(response.body)) return { status: 200, body: response.body };
  if (response?.status === 400 && isRejectedResult(response.body)) return { status: 400, body: response.body };
  return unknownResponse();
}

function isAuthorizePackageRequest(value: unknown): value is SealedResourceAuthorizePackageRequest {
  return isRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'leaseExpiresAt')
      ? ['packageSha256', 'authorizationKey', 'leaseExpiresAt']
      : ['packageSha256', 'authorizationKey'])
    && isPackageSha256(value.packageSha256)
    && isAuthorizationKey(value.authorizationKey)
    && (value.leaseExpiresAt === undefined || isText(value.leaseExpiresAt, 128));
}

function isAcceptedResult(value: unknown): value is SealedResourceAuthorizationResult {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'accepted';
}

function isRejectedResult(value: unknown): value is SealedResourceAuthorizationResult {
  return isRecord(value)
    && (hasExactKeys(value, ['outcome']) || hasExactKeys(value, ['outcome', 'reason']) || hasExactKeys(value, ['outcome', 'error']) || hasExactKeys(value, ['outcome', 'reason', 'error']))
    && value.outcome === 'rejected'
    && (value.reason === undefined || isText(value.reason, 128))
    && (value.error === undefined || isText(value.error, 512));
}

function isPackageSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isAuthorizationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return isBoundedText(value, maxLength) && value.length > 0;
}

function rejectedResponse(): SealedResourceAuthorizationResponse {
  return { status: 400, body: { outcome: 'rejected' } };
}

function unknownResponse(): SealedResourceAuthorizationResponse {
  return { status: 503, body: { outcome: 'unknown' } };
}
