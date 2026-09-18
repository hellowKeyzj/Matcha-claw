import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import type { CloudPackageDownloadRequest, CloudPackageDownloadRecordRequest, CloudPackageListQuery } from '../../main/cloud-account/types';

class InvalidPackageRequestError extends Error {}

type PackageApiContext = Pick<HostApiContext, 'cloudAccountService' | 'runtimeHostTransports'>;

type PackageUploadRequest = Readonly<{
  packagePath?: unknown;
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
      const body = await parsePackageUploadRequest(req);
      sendJson(res, 200, await ctx.cloudAccountService.uploadPackage(body.packagePath));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download-record') {
      const body = await parsePackageDownloadRecordRequest(req);
      sendJson(res, 200, await ctx.cloudAccountService.recordPackageDownload(body));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/download') {
      const body = await parsePackageDownloadRequest(req);
      sendJson(res, 200, await ctx.cloudAccountService.downloadPackage(body));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/packages/install') {
      const body = await parsePackageDownloadRequest(req);
      const download = await ctx.cloudAccountService.downloadPackage(body);
      if (download.packagePath.endsWith('.matcha-agentpkg')) {
        const install = await ctx.runtimeHostTransports.agentsTransport.execute(agentPackageInstallRequest(download.packagePath));
        sendJson(res, install.status, { ...download, install: agentInstallResult(install.body) });
        return true;
      }
      const install = await ctx.runtimeHostTransports.sealedSkillsTransport.install({ packagePath: download.packagePath });
      sendJson(res, install.status, { ...download, install: skillInstallResult(install.body) });
      return true;
    }
  } catch (error) {
    sendJson(res, statusCodeForServiceError(error), { success: false, error: errorMessage(error) });
    return true;
  }

  return false;
}

function agentPackageInstallRequest(packagePath: string) {
  const endpoint = {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  } as const;
  return {
    id: 'subagent.management',
    operationId: 'subagents.package.install',
    scope: { kind: 'agent', endpoint, agentId: 'main' },
    target: { kind: 'subagent' },
    input: { kind: 'packageInstall', endpoint, packagePath },
  };
}

function agentInstallResult(value: unknown): { outcome: 'accepted' | 'rejected' | 'unknown'; agentId?: string } {
  if (!isRecord(value) || value.success !== true || !isRecord(value.package)) return { outcome: 'unknown' };
  const agentId = typeof value.package.agentId === 'string' ? value.package.agentId.trim() : '';
  return agentId ? { outcome: 'accepted', agentId } : { outcome: 'unknown' };
}

function skillInstallResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.outcome === 'accepted' || value.outcome === 'rejected' || value.outcome === 'unknown' || value.outcome === 'notFound'
    ? value
    : { outcome: 'unknown' };
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

async function parsePackageUploadRequest(req: IncomingMessage): Promise<{ packagePath: string }> {
  const body = await parsePackageJsonBody<PackageUploadRequest>(req);
  const packagePath = typeof body.packagePath === 'string' ? body.packagePath.trim() : '';
  if (!isPackagePath(packagePath)) throw new InvalidPackageRequestError('Invalid packagePath');
  return { packagePath };
}

async function parsePackageDownloadRequest(req: IncomingMessage): Promise<CloudPackageDownloadRequest> {
  const body = await parsePackageJsonBody<Record<string, unknown>>(req);
  const packageVersionId = typeof body.packageVersionId === 'string' ? body.packageVersionId.trim() : '';
  if (!packageVersionId) throw new InvalidPackageRequestError('Invalid packageVersionId');
  return compactObject({
    packageVersionId,
    destinationPath: optionalString(body.destinationPath),
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

function isPackagePath(value: string): boolean {
  const lower = value.toLowerCase();
  return value.length > 0
    && value.length <= 4 * 1024
    && !value.includes('\0')
    && (lower.endsWith('.matcha-skillpkg') || lower.endsWith('.matcha-agentpkg'));
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
