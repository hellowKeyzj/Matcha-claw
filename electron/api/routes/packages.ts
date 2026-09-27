import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { unwrapCloudPackageDeviceEnvelope } from '../../main/cloud-account/device-key-store';
import type { CloudPackageAuthorization, CloudPackageDownloadRequest, CloudPackageDownloadRecordRequest, CloudPackageListQuery, CloudPackageLocalDownload } from '../../main/cloud-account/types';

class InvalidPackageRequestError extends Error {}

type PackageApiContext = Pick<HostApiContext, 'cloudAccountService' | 'runtimeHostTransports'>;

type CloudPackageInstallMetadata = Readonly<{
  packageVersionId: string;
  packageType: string;
  packageSha256: string;
  fileName: string;
}>;

type SkillInstallResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
}>;

type SealedSkillPackageUploadRequest = Readonly<{
  skillKey?: unknown;
}>;

type SealedAgentPackageUploadRequest = Readonly<{
  agentId?: unknown;
}>;

type RuntimeCloudPackageExport = Readonly<{
  packagePath?: string;
}>;

export async function handlePackageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PackageApiContext,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/packages/')) return false;

  if (!ctx.cloudAccountService) {
    sendJson(res, 503, { success: false, error: 'Cloud account service is unavailable' });
    return true;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/packages/mine') {
      sendJson(res, 200, await ctx.cloudAccountService.listOwnedPackages(packageListQuery(url)));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/packages/market') {
      sendJson(res, 200, await ctx.cloudAccountService.listMarketPackages(packageListQuery(url)));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload') {
      sendJson(res, 400, { success: false, error: 'Package upload requires a sealed skillKey or agentId' });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-skill') {
      const body = await parseSealedSkillPackageUploadRequest(req);
      const cloudKey = await ctx.cloudAccountService.fetchSealedCloudKey();
      const exported = await ctx.runtimeHostTransports.sealedSkillsTransport.exportCloud(compactObject({
        skillKey: body.skillKey,
        cloudPublicKey: cloudKey.publicKey,
        cloudKeyId: cloudKey.keyId,
      }));
      if (exported.status !== 200 || !isRuntimeCloudPackageExport(exported.body)) {
        sendJson(res, exported.status, { success: false, error: runtimeExportError(exported.body, 'Skill package cloud export failed') });
        return true;
      }
      sendJson(res, 200, await ctx.cloudAccountService.uploadPackage(exported.body.packagePath));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-agent') {
      const body = await parseSealedAgentPackageUploadRequest(req);
      const cloudKey = await ctx.cloudAccountService.fetchSealedCloudKey();
      const exported = await ctx.runtimeHostTransports.agentsTransport.execute(agentPackageExportCloudRequest(body.agentId, cloudKey.publicKey, cloudKey.keyId));
      if (exported.status !== 200 || !isAgentPackageCloudExport(exported.body)) {
        sendJson(res, exported.status, { success: false, error: runtimeExportError(exported.body, 'Agent package cloud export failed') });
        return true;
      }
      sendJson(res, 200, await ctx.cloudAccountService.uploadPackage(exported.body.package.packagePath));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download-record') {
      const body = await parsePackageDownloadRecordRequest(req);
      sendJson(res, 200, sanitizePublicPackagePayload(await ctx.cloudAccountService.recordPackageDownload(body)));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download') {
      const body = await parsePackageDownloadRequest(req);
      sendJson(res, 200, sanitizePublicPackagePayload(await ctx.cloudAccountService.downloadPackage(body)));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install') {
      const body = await parsePackageDownloadRequest(req);
      const authorization = await ctx.cloudAccountService.authorizePackage(body);
      if (isExpiredLease(authorization.leaseExpiresAt)) {
        sendJson(res, 403, { success: false, error: 'Cloud package authorization lease has expired' });
        return true;
      }
      const authorizationKey = await unwrapCloudPackageDeviceEnvelope(authorization.deviceEnvelope);
      if (!authorizationKey) throw new InvalidPackageRequestError('Package authorization is unavailable');
      const download = await ctx.cloudAccountService.downloadPackage(body);
      const cloudMetadata = packageInstallMetadata(download, authorization);
      const runtimeAuthorization = await ctx.runtimeHostTransports.sealedResourceAuthorizationTransport.authorizePackage({
        packageSha256: cloudMetadata.packageSha256,
        authorizationKey,
        leaseExpiresAt: authorization.leaseExpiresAt,
      });
      if (runtimeAuthorization.status !== 200 || runtimeAuthorization.body.outcome !== 'accepted') {
        sendJson(res, runtimeAuthorization.status, { success: false, error: 'Package authorization failed' });
        return true;
      }
      if (download.packagePath.endsWith('.matcha-agentpkg')) {
        const install = await ctx.runtimeHostTransports.agentsTransport.execute(agentPackageInstallRequest(download.packagePath, cloudMetadata));
        await ctx.cloudAccountService.recordPackageDownload(downloadRecordRequest(body));
        sendJson(res, install.status, { ...sanitizePublicPackagePayload(download), install: agentInstallResult(install.body) });
        return true;
      }
      const install = await ctx.runtimeHostTransports.sealedSkillsTransport.install({ packagePath: download.packagePath, cloudMetadata });
      const installResult = skillInstallResult(install.body);
      await ctx.cloudAccountService.recordPackageDownload(downloadRecordRequest(body));
      sendJson(res, install.status, { ...sanitizePublicPackagePayload(download), install: installResult });
      return true;
    }
  } catch (error) {
    sendJson(res, statusCodeForServiceError(error), { success: false, error: errorMessage(error) });
    return true;
  }

  return false;
}

function agentPackageExportCloudRequest(agentId: string, cloudPublicKey: string, cloudKeyId: string | undefined) {
  const endpoint = runtimeEndpoint();
  return {
    id: 'subagent.management',
    operationId: 'subagents.package.exportCloud',
    scope: { kind: 'agent', endpoint, agentId: 'main' },
    target: { kind: 'subagent', subagentId: agentId },
    input: compactObject({ kind: 'packageExportCloud', endpoint, agentId, cloudPublicKey, cloudKeyId }),
  };
}

function agentPackageInstallRequest(packagePath: string, cloudMetadata: CloudPackageInstallMetadata) {
  const endpoint = runtimeEndpoint();
  return {
    id: 'subagent.management',
    operationId: 'subagents.package.install',
    scope: { kind: 'agent', endpoint, agentId: 'main' },
    target: { kind: 'subagent' },
    input: { kind: 'packageInstall', endpoint, packagePath, cloudMetadata },
  };
}

function runtimeEndpoint() {
  return {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  } as const;
}

function agentInstallResult(value: unknown): { outcome: 'accepted' | 'rejected' | 'unknown'; agentId?: string } {
  if (!isRecord(value) || value.success !== true || !isRecord(value.package)) return { outcome: 'unknown' };
  const agentId = typeof value.package.agentId === 'string' ? value.package.agentId.trim() : '';
  return agentId ? { outcome: 'accepted', agentId } : { outcome: 'unknown' };
}

function isRuntimeCloudPackageExport(value: unknown): value is RuntimeCloudPackageExport {
  return isRecord(value) && typeof value.packagePath === 'string' && isPackagePath(value.packagePath);
}

function isAgentPackageCloudExport(value: unknown): value is Readonly<{ package: RuntimeCloudPackageExport }> {
  return isRecord(value)
    && value.success === true
    && isRecord(value.package)
    && isRuntimeCloudPackageExport(value.package);
}

function runtimeExportError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const detail = typeof value.reason === 'string' ? value.reason : typeof value.error === 'string' ? value.error : '';
  if (!detail || detail.length > 256 || detail.includes('\\') || detail.includes('/')) return fallback;
  return `${fallback}: ${detail}`;
}

function skillInstallResult(value: unknown): SkillInstallResult {
  if (!isRecord(value)) return { outcome: 'unknown' };
  if (value.outcome !== 'accepted' && value.outcome !== 'rejected' && value.outcome !== 'unknown' && value.outcome !== 'notFound') {
    return { outcome: 'unknown' };
  }
  const skillKey = typeof value.skillKey === 'string' ? value.skillKey.trim() : '';
  if (value.outcome === 'accepted' && !skillKey) return { outcome: 'unknown' };
  return skillKey ? { outcome: value.outcome, skillKey } : { outcome: value.outcome };
}

function packageListQuery(url: URL): CloudPackageListQuery {
  return compactObject({
    page: positiveInt(url.searchParams.get('page')),
    pageSize: positiveInt(url.searchParams.get('pageSize') ?? url.searchParams.get('page_size')),
    search: trimmed(url.searchParams.get('search')),
    packageType: trimmed(url.searchParams.get('packageType')),
  }) as CloudPackageListQuery;
}

async function parsePackageJsonBody<T>(req: IncomingMessage): Promise<T> {
  try {
    return await parseJsonBody<T>(req);
  } catch {
    throw new InvalidPackageRequestError('Invalid package request body');
  }
}

async function parseSealedSkillPackageUploadRequest(req: IncomingMessage): Promise<{ skillKey: string }> {
  const body = await parsePackageJsonBody<SealedSkillPackageUploadRequest>(req);
  const skillKey = typeof body.skillKey === 'string' ? body.skillKey.trim() : '';
  if (!isSkillKey(skillKey)) throw new InvalidPackageRequestError('Invalid skillKey');
  return { skillKey };
}

async function parseSealedAgentPackageUploadRequest(req: IncomingMessage): Promise<{ agentId: string }> {
  const body = await parsePackageJsonBody<SealedAgentPackageUploadRequest>(req);
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!isSkillKey(agentId)) throw new InvalidPackageRequestError('Invalid agentId');
  return { agentId };
}

async function parsePackageDownloadRequest(req: IncomingMessage): Promise<CloudPackageDownloadRequest> {
  const body = await parsePackageJsonBody<Record<string, unknown>>(req);
  const packageVersionId = typeof body.packageVersionId === 'string' ? body.packageVersionId.trim() : '';
  if (!packageVersionId) throw new InvalidPackageRequestError('Invalid packageVersionId');
  return compactObject({
    packageVersionId,
    packageType: optionalString(body.packageType),
    filename: optionalString(body.filename),
    clientVersion: optionalString(body.clientVersion),
    installId: optionalString(body.installId),
    source: optionalString(body.source),
  }) as CloudPackageDownloadRequest;
}

async function parsePackageDownloadRecordRequest(req: IncomingMessage): Promise<CloudPackageDownloadRecordRequest> {
  const body = await parsePackageJsonBody<Record<string, unknown>>(req);
  const packageVersionId = typeof body.packageVersionId === 'string' ? body.packageVersionId.trim() : '';
  if (!packageVersionId) throw new InvalidPackageRequestError('Invalid packageVersionId');
  return compactObject({
    packageVersionId,
    clientVersion: optionalString(body.clientVersion),
    installId: optionalString(body.installId),
    source: optionalString(body.source),
  }) as CloudPackageDownloadRecordRequest;
}

function packageInstallMetadata(download: CloudPackageLocalDownload, authorization: CloudPackageAuthorization): CloudPackageInstallMetadata {
  const packageVersionId = stringField(download.packageVersionId) || stringField(authorization.packageVersionId);
  const packageType = stringField(authorization.packageType);
  const packageSha256 = stringField(download.packageSha256);
  const fileName = stringField(download.filename);
  if (!packageVersionId || !packageType || !isPackageSha256(packageSha256) || !fileName) {
    throw new InvalidPackageRequestError('Package download metadata is invalid');
  }
  return { packageVersionId, packageType, packageSha256, fileName };
}

function downloadRecordRequest(request: CloudPackageDownloadRequest): CloudPackageDownloadRecordRequest {
  return compactObject({
    packageVersionId: request.packageVersionId,
    clientVersion: request.clientVersion,
    installId: request.installId,
    source: request.source,
  }) as CloudPackageDownloadRecordRequest;
}

function sanitizePublicPackagePayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const {
    packagePath: _packagePath,
    deviceEnvelope: _deviceEnvelope,
    authorizationKey: _authorizationKey,
    contentKey: _contentKey,
    rawPayload: _rawPayload,
    token: _token,
    ...publicPayload
  } = value;
  return publicPayload;
}

function isPackagePath(value: string): boolean {
  const lower = value.toLowerCase();
  return value.length > 0
    && value.length <= 4 * 1024
    && !value.includes('\0')
    && (lower.endsWith('.matcha-skillpkg') || lower.endsWith('.matcha-agentpkg'));
}

function isPackageSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isExpiredLease(value: string): boolean {
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isSkillKey(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('\0');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function trimmed(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function positiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function statusCodeForServiceError(error: unknown): 400 | 401 | 502 {
  if (error instanceof InvalidPackageRequestError) return 400;
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  if (status === 400 || status === 404) return 400;
  if (status === 401 || status === 403) return 401;
  return 502;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Package registry request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
