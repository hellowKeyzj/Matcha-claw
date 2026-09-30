import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import type { CloudPackageDownloadRequest, CloudPackageListQuery } from '../../main/cloud-account/types';
import { isSkillsCallReceipt } from '../../main/runtime-host-delivery/transport/skills/management';
import { isCallId } from '../../../src/types/call-log/decode';
import { isCloudPackageOperationId } from '../../../src/types/cloud-package-operation';
import { PackageOperationError } from '../../main/cloud-account/package-operations';

class InvalidPackageRequestError extends Error {}

type PackageApiContext = Pick<HostApiContext, 'cloudAccountService' | 'runtimeHostTransports'>;

type SkillInstallResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
  reason?: string;
  error?: string;
}>;

type SealedSkillPackageUploadRequest = Readonly<{
  skillKey?: unknown;
}>;

type SealedAgentPackageUploadRequest = Readonly<{
  agentId?: unknown;
}>;

export async function handlePackageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PackageApiContext,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/packages/')) return false;

  if (req.method === 'GET' && url.pathname === '/api/packages/installed') {
    const result = await ctx.runtimeHostTransports.sealedResourceAuthorizationTransport.listCloudPackages();
    sendJson(res, result.status, { packages: result.body.packages.map(({ packageVersionId, packageType, packageSha256, fileName }) => ({ packageVersionId, packageType, packageSha256, fileName })) });
    return true;
  }

  if (!ctx.cloudAccountService) {
    sendJson(res, 503, { success: false, error: 'Cloud account service is unavailable' });
    return true;
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/packages/operation-result') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !isCloudPackageOperationId(body.operationId)) {
        throw new InvalidPackageRequestError('Invalid cloud package operationId');
      }
      const result = ctx.cloudAccountService.readPackageOperation(body.operationId);
      sendJson(res, result ? 200 : 404, result ?? { outcome: 'notFound' });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install/confirm') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !isCallId(body.callId)) {
        throw new InvalidPackageRequestError('Invalid package install callId');
      }
      const result = await ctx.runtimeHostTransports.callLogTransport.get({ callId: body.callId });
      if (result.status !== 200 || !('module' in result.body)) {
        sendJson(res, result.status, { install: { outcome: 'unknown' } });
        return true;
      }
      const call = result.body;
      if (call.callId === body.callId && call.module === 'subagents' && call.command === 'subagents.package.install'
        && call.detail.endpoint === 'openclaw:local' && ['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
        const completed = await ctx.runtimeHostTransports.agentsTransport.result({
          callId: body.callId, operationId: 'subagents.package.install', endpoint: runtimeEndpoint(),
        });
        if (completed.status !== 200 || !isRecord(completed.body) || completed.body.callId !== body.callId
          || completed.body.operationId !== 'subagents.package.install' || !isRecord(completed.body.body)) {
          sendJson(res, completed.status === 200 ? 502 : completed.status, { install: { outcome: 'unknown' } });
          return true;
        }
        const install = agentInstallResult(completed.body.body);
        if (install.outcome !== 'accepted') install.outcome = call.status === 'rejected' ? 'rejected' : 'unknown';
        const confirmed = completed.body.status === 200 && call.status === 'succeeded'
          && call.detail.outcome === 'packageInstalled' && install.outcome === 'accepted'
          && install.agentId === call.detail.agentId;
        if ((install.outcome === 'accepted' && !confirmed)
          || (install.outcome !== 'accepted' && (call.status === 'succeeded' || completed.body.status === 200))) {
          sendJson(res, 502, { install: { outcome: 'unknown' } });
          return true;
        }
        ctx.cloudAccountService.acknowledgePackageInstall(body.callId, confirmed);
        sendJson(res, 200, { install });
        return true;
      }
      if (call.callId !== body.callId || call.module !== 'skills' || call.command !== 'sealedSkills.install'
        || !['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
        sendJson(res, 409, { install: { outcome: 'unknown' } });
        return true;
      }
      const confirmed = call.status === 'succeeded' && call.detail.access === 'write'
        && call.detail.outcome === 'accepted' && typeof call.detail.skillKey === 'string';
      const install: SkillInstallResult = confirmed
        ? { outcome: 'accepted', skillKey: call.detail.skillKey }
        : { outcome: call.status === 'failed' && call.detail.outcome === 'notFound' ? 'notFound'
          : call.status === 'rejected' && call.detail.outcome === 'rejected' ? 'rejected' : 'unknown' };
      ctx.cloudAccountService.acknowledgePackageInstall(body.callId, confirmed);
      sendJson(res, 200, { install });
      return true;
    }
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
      const reservation = ctx.cloudAccountService.reserveSkillExport();
      try {
        const cloudKey = await ctx.cloudAccountService.fetchSealedCloudKey();
        const exported = await ctx.runtimeHostTransports.sealedSkillsTransport.exportCloud(compactObject({
          skillKey: body.skillKey,
          cloudPublicKey: cloudKey.publicKey,
          cloudKeyId: cloudKey.keyId,
        }));
        if (exported.status !== 202 || !isSkillsCallReceipt(exported.body)) {
          sendJson(res, exported.status === 200 || exported.status === 202 ? 502 : exported.status, { success: false, error: runtimeExportError(exported.body, 'Skill package cloud export failed') });
          return true;
        }
        ctx.cloudAccountService.bindSkillExport(reservation, exported.body.callId);
        sendJson(res, 202, exported.body);
        return true;
      } finally {
        ctx.cloudAccountService.releaseSkillExport(reservation);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-skill/confirm') {
      const body = await parsePackageJsonBody<Record<string, unknown>>(req);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !isCallId(body.callId)) {
        throw new InvalidPackageRequestError('Invalid package export callId');
      }
      sendJson(res, 202, ctx.cloudAccountService.admitPackageOperation('confirmSealedSkillUpload', { callId: body.callId }));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/upload/sealed-agent') {
      const body = await parseSealedAgentPackageUploadRequest(req);
      sendJson(res, 202, ctx.cloudAccountService.admitPackageOperation('uploadSealedAgent', body));
      return true;
    }
    const publishMatch = url.pathname.match(/^\/api\/packages\/([^/]+)\/publish$/);
    if (req.method === 'POST' && publishMatch) {
      let packageVersionId: string;
      try { packageVersionId = decodeURIComponent(publishMatch[1]).trim(); } catch { throw new InvalidPackageRequestError('Invalid packageVersionId'); }
      if (!isSkillKey(packageVersionId)) throw new InvalidPackageRequestError('Invalid packageVersionId');
      sendJson(res, 200, await ctx.cloudAccountService.publishPackage(packageVersionId));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download') {
      const body = await parsePackageDownloadRequest(req);
      sendJson(res, 202, ctx.cloudAccountService.admitPackageOperation('download', body));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install') {
      const body = await parsePackageDownloadRequest(req);
      sendJson(res, 202, ctx.cloudAccountService.admitPackageOperation('install', body));
      return true;
    }
  } catch (error) {
    if (error instanceof PackageOperationError) {
      sendJson(res, error.status, { success: false, error: error.message, message: error.message, code: error.code });
      return true;
    }
    const code = isRecord(error) && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined;
    const message = errorMessage(error);
    sendJson(res, statusCodeForServiceError(error), {
      success: false, error: message, message: code === undefined ? message : `${code}: ${message}`,
      ...(code === undefined ? {} : { code }),
      ...(isRecord(error) && typeof error.reason === 'string' ? { reason: error.reason } : {}),
    });
    return true;
  }

  return false;
}

function runtimeEndpoint() {
  return {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  } as const;
}

function agentInstallResult(value: unknown): { outcome: 'accepted' | 'rejected' | 'unknown'; agentId?: string; reason?: string; error?: string; compensation?: Record<string, unknown> } {
  if (!isRecord(value)) return { outcome: 'unknown' };
  if (value.outcome === 'rejected' || value.success === false) return {
    outcome: 'rejected', ...installFailureDetail(value),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(isRecord(value.compensation) ? { compensation: {
      outcome: value.compensation.outcome,
      failedCount: value.compensation.failedCount,
      purgeFailedCount: value.compensation.purgeFailedCount,
    } } : {}),
  };
  if (value.success !== true || !isRecord(value.package)) return { outcome: 'unknown', ...installFailureDetail(value) };
  const agentId = typeof value.package.agentId === 'string' ? value.package.agentId.trim() : '';
  return agentId ? { outcome: 'accepted', agentId } : { outcome: 'unknown' };
}

function runtimeExportError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const detail = typeof value.reason === 'string' ? value.reason : typeof value.error === 'string' ? value.error : '';
  if (!detail || detail.length > 256 || detail.includes('\\') || detail.includes('/')) return fallback;
  return `${fallback}: ${detail}`;
}

function installFailureDetail(value: Record<string, unknown>): { reason?: string; error?: string } {
  return {
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
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
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'agentId')) throw new InvalidPackageRequestError('Invalid agent upload request');
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!isSkillKey(agentId)) throw new InvalidPackageRequestError('Invalid agentId');
  return { agentId };
}

async function parsePackageDownloadRequest(req: IncomingMessage): Promise<CloudPackageDownloadRequest> {
  const body = await parsePackageJsonBody<Record<string, unknown>>(req);
  if (!isRecord(body) || !Object.hasOwn(body, 'packageVersionId')
    || !Object.keys(body).every((key) => ['packageVersionId', 'packageType', 'filename', 'clientVersion', 'installId', 'source'].includes(key))
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
  }) as CloudPackageDownloadRequest;
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
