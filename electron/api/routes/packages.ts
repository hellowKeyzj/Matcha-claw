import type { HostApiContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { CloudPackageListQuery } from '../../main/cloud-account/types';
import { isSkillsRuntimeScope, type SkillsRuntimeScope } from '../../main/runtime-host-delivery/transport/skills/management';
import { isCallId } from '../../../src/types/call-log/decode';
import { isCloudPackageOperationId, type CloudPackageOperationRequests } from '../../../src/types/cloud-package-operation';
import { listInstalledPackages, PackageOperationError } from '../../main/cloud-account/package-operations';

class InvalidPackageRequestError extends Error {}

type PackageApiContext = Pick<HostApiContext, 'cloudAccountService' | 'runtimeHostTransports'>;

type SealedSkillPackageUploadRequest = Readonly<{
  skillKey?: unknown;
  scope?: unknown;
}>;

type SealedAgentPackageUploadRequest = Readonly<{
  agentId?: unknown;
}>;

export async function handlePackageRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: PackageApiContext,
): Promise<HostApiRouteResult> {
  if (!url.pathname.startsWith('/api/packages/')) return undefined;

  if (req.method === 'GET' && url.pathname === '/api/packages/installed') {
    const result = await listInstalledPackages(ctx.runtimeHostTransports.sealedResourceAuthorizationTransport);
    return jsonResult(result.status, result.body);
  }

  if (!ctx.cloudAccountService) {
    return jsonResult(503, { success: false, error: 'Cloud account service is unavailable' });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/packages/operation-result') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !isCloudPackageOperationId(body.operationId)) {
        throw new InvalidPackageRequestError('Invalid cloud package operationId');
      }
      const result = ctx.cloudAccountService.readPackageOperation(body.operationId);
      return jsonResult(result ? 200 : 404, result ?? { outcome: 'notFound' });
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install/confirm') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !isCallId(body.callId)) {
        throw new InvalidPackageRequestError('Invalid package install callId');
      }
      const result = await ctx.cloudAccountService.confirmPackageInstall(body.callId);
      return jsonResult(result.status, result.body);
    }
    if (req.method === 'GET' && url.pathname === '/api/packages/mine') {
      return jsonResult(200, await ctx.cloudAccountService.listOwnedPackages(packageListQuery(url)));
    }
    if (req.method === 'GET' && url.pathname === '/api/packages/market') {
      return jsonResult(200, await ctx.cloudAccountService.listMarketPackages(packageListQuery(url)));
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload') {
      return jsonResult(400, { success: false, error: 'Package upload requires a sealed skillKey or agentId' });
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-skill') {
      const body = await parseSealedSkillPackageUploadRequest(req);
      const result = await ctx.cloudAccountService.exportSealedSkillPackage(body);
      return jsonResult(result.status, result.body);
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-skill/confirm') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || !Object.keys(body).every((key) => key === 'callId' || key === 'scope') || !isCallId(body.callId)
        || (Object.hasOwn(body, 'scope') && !isSkillsRuntimeScope(body.scope))) {
        throw new InvalidPackageRequestError('Invalid package export callId');
      }
      return jsonResult(202, ctx.cloudAccountService.admitPackageOperation('confirmSealedSkillUpload', {
        callId: body.callId, ...(body.scope === undefined ? {} : { scope: body.scope as SkillsRuntimeScope }),
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-agent') {
      const body = await parseSealedAgentPackageUploadRequest(req);
      return jsonResult(202, ctx.cloudAccountService.admitPackageOperation('uploadSealedAgent', body));
    }
    const publishMatch = url.pathname.match(/^\/api\/packages\/([^/]+)\/publish$/);
    if (req.method === 'POST' && publishMatch) {
      let packageVersionId: string;
      try { packageVersionId = decodeURIComponent(publishMatch[1]).trim(); } catch { throw new InvalidPackageRequestError('Invalid packageVersionId'); }
      if (!isSkillKey(packageVersionId)) throw new InvalidPackageRequestError('Invalid packageVersionId');
      return jsonResult(200, await ctx.cloudAccountService.publishPackage(packageVersionId));
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download') {
      const body = await parsePackageDownloadRequest(req);
      return jsonResult(202, ctx.cloudAccountService.admitPackageOperation('download', body));
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install') {
      const body = await parsePackageDownloadRequest(req, true);
      return jsonResult(202, ctx.cloudAccountService.admitPackageOperation('install', body));
    }
  } catch (error) {
    if (error instanceof PackageOperationError) {
      return jsonResult(error.status, { success: false, error: error.message, message: error.message, code: error.code });
    }
    const code = isRecord(error) && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined;
    const message = errorMessage(error);
    return jsonResult(statusCodeForServiceError(error), {
      success: false, error: message, message: code === undefined ? message : `${code}: ${message}`,
      ...(code === undefined ? {} : { code }),
      ...(isRecord(error) && typeof error.reason === 'string' ? { reason: error.reason } : {}),
    });
  }

  return undefined;
}

function packageListQuery(url: URL): CloudPackageListQuery {
  return compactObject({
    page: positiveInt(url.searchParams.get('page')),
    pageSize: positiveInt(url.searchParams.get('pageSize') ?? url.searchParams.get('page_size')),
    search: trimmed(url.searchParams.get('search')),
    packageType: trimmed(url.searchParams.get('packageType')),
  }) as CloudPackageListQuery;
}

async function parsePackageJsonBody<T>(req: HostApiRequest): Promise<T> {
  try {
    return await req.readJson<T>();
  } catch {
    throw new InvalidPackageRequestError('Invalid package request body');
  }
}

async function parseSealedSkillPackageUploadRequest(req: HostApiRequest): Promise<{ skillKey: string; scope?: SkillsRuntimeScope }> {
  const body = await parsePackageJsonBody<SealedSkillPackageUploadRequest>(req);
  if (!isRecord(body) || !Object.keys(body).every((key) => key === 'skillKey' || key === 'scope')
    || (Object.hasOwn(body, 'scope') && !isSkillsRuntimeScope(body.scope))) {
    throw new InvalidPackageRequestError('Invalid sealed skill upload request');
  }
  const skillKey = typeof body.skillKey === 'string' ? body.skillKey.trim() : '';
  if (!isSkillKey(skillKey)) throw new InvalidPackageRequestError('Invalid skillKey');
  return { skillKey, ...(body.scope === undefined ? {} : { scope: body.scope as SkillsRuntimeScope }) };
}

async function parseSealedAgentPackageUploadRequest(req: HostApiRequest): Promise<{ agentId: string }> {
  const body = await parsePackageJsonBody<SealedAgentPackageUploadRequest>(req);
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'agentId')) throw new InvalidPackageRequestError('Invalid agent upload request');
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!isSkillKey(agentId)) throw new InvalidPackageRequestError('Invalid agentId');
  return { agentId };
}

async function parsePackageDownloadRequest(req: HostApiRequest, allowRuntimeScope = false): Promise<CloudPackageOperationRequests['install']> {
  const body = await parsePackageJsonBody<Record<string, unknown>>(req);
  if (!isRecord(body) || !Object.hasOwn(body, 'packageVersionId')
    || !Object.keys(body).every((key) => ['packageVersionId', 'packageType', 'filename', 'clientVersion', 'installId', 'source'].includes(key) || (allowRuntimeScope && key === 'scope'))
    || (Object.hasOwn(body, 'scope') && !isSkillsRuntimeScope(body.scope))
    || !['packageType', 'filename', 'clientVersion', 'installId', 'source'].every((key) => body[key] === undefined || (typeof body[key] === 'string' && body[key].length <= 512 && !body[key].includes('\0')))) {
    throw new InvalidPackageRequestError('Invalid package download request');
  }
  const packageVersionId = typeof body.packageVersionId === 'string' ? body.packageVersionId.trim() : '';
  if (!isSkillKey(packageVersionId)) throw new InvalidPackageRequestError('Invalid packageVersionId');
  return compactObject({
    packageVersionId,
    packageType: optionalString(body.packageType),
    filename: optionalString(body.filename),
    clientVersion: optionalString(body.clientVersion),
    installId: optionalString(body.installId),
    source: optionalString(body.source),
    scope: body.scope,
  }) as CloudPackageOperationRequests['install'];
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

function statusCodeForServiceError(error: unknown): number {
  if (error instanceof InvalidPackageRequestError) return 400;
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Package registry request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
