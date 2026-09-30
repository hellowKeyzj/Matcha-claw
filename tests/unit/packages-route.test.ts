import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handlePackageRoutes } from '../../electron/api/routes/packages';
import { CloudAccountClientError } from '../../electron/main/cloud-account/client';

function incoming(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), { method, headers: { 'content-type': 'application/json' } });
}
function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return { state, raw: {
    get statusCode() { return state.statusCode; }, set statusCode(value: number) { state.statusCode = value; },
    setHeader: () => {}, end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
  } };
}
const packageSha256 = 'a'.repeat(64);
const receipt = { callId: 'a'.repeat(32), accepted: true };
const operationReceipt = { operationId: 'cloud-package:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accepted: true };
const forbiddenPublicFields = /packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/;

async function route(path: string, body: unknown, context: unknown, method = 'POST') {
  const result = response();
  await expect(handlePackageRoutes(incoming(body, method) as never, result.raw as never, new URL(`http://127.0.0.1${path}`), context as never)).resolves.toBe(true);
  return result.state;
}

describe('packages host API route', () => {
  it('uploads sealed skill cloud packages through cloud export', async () => {
    const reservation = { epoch: 1 };
    const cloudAccountService = {
      fetchSealedCloudKey: vi.fn().mockResolvedValue({ version: 1, publicKey: 'cloud-public-key', keyId: 'cloud-key' }),
      reserveSkillExport: vi.fn().mockReturnValue(reservation), bindSkillExport: vi.fn(), releaseSkillExport: vi.fn(),
      admitPackageOperation: vi.fn().mockReturnValue(operationReceipt),
    };
    const sealedSkillsTransport = { exportCloud: vi.fn().mockResolvedValue({ status: 202, body: receipt }) };
    const ctx = { cloudAccountService, runtimeHostTransports: { sealedSkillsTransport } };
    expect(await route('/api/packages/upload/sealed-skill', { skillKey: 'skill:openclaw:calendar' }, ctx)).toEqual({ statusCode: 202, body: receipt });
    const result = await route('/api/packages/upload/sealed-skill/confirm', { callId: receipt.callId }, ctx);
    expect(sealedSkillsTransport.exportCloud).toHaveBeenCalledWith({ skillKey: 'skill:openclaw:calendar', cloudPublicKey: 'cloud-public-key', cloudKeyId: 'cloud-key' });
    expect(cloudAccountService.bindSkillExport).toHaveBeenCalledWith(reservation, receipt.callId);
    expect(cloudAccountService.releaseSkillExport).toHaveBeenCalledWith(reservation);
    expect(cloudAccountService.admitPackageOperation).toHaveBeenCalledWith('confirmSealedSkillUpload', { callId: receipt.callId });
    expect(result).toEqual({ statusCode: 202, body: operationReceipt });
  });

  it('uploads sealed agent cloud packages through cloud export', async () => {
    const cloudAccountService = { admitPackageOperation: vi.fn().mockReturnValue(operationReceipt) };
    const agentsTransport = { execute: vi.fn() };
    expect(await route('/api/packages/upload/sealed-agent', { agentId: 'writer' }, { cloudAccountService, runtimeHostTransports: { agentsTransport } })).toEqual({ statusCode: 202, body: operationReceipt });
    expect(cloudAccountService.admitPackageOperation).toHaveBeenCalledWith('uploadSealedAgent', { agentId: 'writer' });
    expect(agentsTransport.execute).not.toHaveBeenCalled();
  });

  it('keeps download a thin adapter without secrets', async () => {
    const metadata = { packageVersionId: 'version-calendar', filename: 'calendar.matcha-skillpkg', bytes: 1024, packageSha256 };
    const completed = { operationId: operationReceipt.operationId, kind: 'download', state: 'succeeded', result: metadata };
    const cloudAccountService = { admitPackageOperation: vi.fn().mockReturnValue(operationReceipt), readPackageOperation: vi.fn().mockReturnValue(completed) };
    const ctx = { cloudAccountService, runtimeHostTransports: {} };
    const download = await route('/api/packages/download', { packageVersionId: 'version-calendar' }, ctx);
    expect(download).toEqual({ statusCode: 202, body: operationReceipt });
    expect(cloudAccountService.admitPackageOperation).toHaveBeenCalledWith('download', { packageVersionId: 'version-calendar' });
    const result = await route('/api/packages/operation-result', { operationId: operationReceipt.operationId }, ctx);
    expect(result.body).toMatchObject({ result: metadata });
    expect(JSON.stringify(result.body)).not.toMatch(forbiddenPublicFields);
  });

  it.each(['skill', 'agent'] as const)('installs prepared %s packages and tracks only actual success without recording again', async (packageType) => {
    const prepared = {
      download: { packageVersionId: 'version-calendar', packagePath: `C:/sealed/calendar.matcha-${packageType}pkg`, filename: `calendar.matcha-${packageType}pkg`, bytes: 1024, packageSha256 },
      cloudMetadata: { packageVersionId: 'version-calendar', packageType, packageSha256, fileName: `calendar.matcha-${packageType}pkg` },
      epoch: 1, leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    };
    const cloudAccountService = {
      admitPackageOperation: vi.fn().mockReturnValue(operationReceipt), packageInstalled: vi.fn(),
      acknowledgePackageInstall: vi.fn((_callId: string, confirmed: boolean) => { if (confirmed) cloudAccountService.packageInstalled(prepared); }),
    };
    const agentsTransport = {
      execute: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
      result: vi.fn().mockResolvedValue({ status: 200, body: { callId: receipt.callId, operationId: 'subagents.package.install', status: 200, body: { success: true, package: { agentId: 'calendar' } } } }),
    };
    const sealedSkillsTransport = { install: vi.fn().mockResolvedValue({ status: 202, body: receipt }) };
    const callLogTransport = { get: vi.fn().mockResolvedValue({ status: 200, body: {
      callId: receipt.callId, module: packageType === 'skill' ? 'skills' : 'subagents',
      command: packageType === 'skill' ? 'sealedSkills.install' : 'subagents.package.install', status: 'succeeded',
      detail: packageType === 'skill' ? { access: 'write', outcome: 'accepted', skillKey: 'vendor/calendar' }
        : { endpoint: 'openclaw:local', outcome: 'packageInstalled', agentId: 'calendar' },
    } }) };
    const ctx = { cloudAccountService, runtimeHostTransports: { agentsTransport, sealedSkillsTransport, callLogTransport } };
    expect(await route('/api/packages/install', { packageVersionId: 'version-calendar', packageType }, ctx)).toEqual({ statusCode: 202, body: operationReceipt });
    expect(cloudAccountService.admitPackageOperation).toHaveBeenCalledWith('install', { packageVersionId: 'version-calendar', packageType });
    expect(agentsTransport.execute).not.toHaveBeenCalled();
    expect(sealedSkillsTransport.install).not.toHaveBeenCalled();
    const result = await route('/api/packages/install/confirm', { callId: receipt.callId }, ctx);
    expect(cloudAccountService.packageInstalled).toHaveBeenCalledWith(prepared);
    expect(cloudAccountService.packageInstalled).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(result.body)).not.toMatch(forbiddenPublicFields);
    callLogTransport.get.mockResolvedValueOnce({ status: 200, body: {
      callId: receipt.callId, module: packageType === 'skill' ? 'skills' : 'subagents',
      command: packageType === 'skill' ? 'sealedSkills.install' : 'subagents.package.install', status: 'failed',
      detail: packageType === 'skill' ? { access: 'write', outcome: 'notFound' } : { endpoint: 'openclaw:local', outcome: 'unavailable' },
    } } as never);
    agentsTransport.result.mockResolvedValueOnce({ status: 200, body: { callId: receipt.callId, operationId: 'subagents.package.install', status: 503, body: { success: false, error: 'Subagent management is unavailable' } } } as never);
    cloudAccountService.packageInstalled.mockClear();
    const rejected = await route('/api/packages/install/confirm', { callId: receipt.callId }, ctx);
    expect(rejected.statusCode).toBe(200);
    expect(cloudAccountService.packageInstalled).not.toHaveBeenCalled();
  });

  it('returns direct published CloudPackageVersion', async () => {
    const published = { packageId: 'pkg', packageVersionId: 'v1', status: 'published', name: 'calendar' };
    const cloudAccountService = { publishPackage: vi.fn().mockResolvedValue(published) };
    expect(await route('/api/packages/v1/publish', {}, { cloudAccountService, runtimeHostTransports: {} })).toEqual({ statusCode: 200, body: published });
    expect(cloudAccountService.publishPackage).toHaveBeenCalledWith('v1');
  });

  it('projects installed metadata without cloud login or private fields', async () => {
    const metadata = { packageVersionId: 'v1', packageType: 'skill', packageSha256, fileName: 'calendar.matcha-skillpkg' };
    const transport = { listCloudPackages: vi.fn().mockResolvedValue({ status: 200, body: { packages: [{ ...metadata, packagePath: 'private', authorizationKey: 'secret' }] } }) };
    expect(await route('/api/packages/installed', {}, { runtimeHostTransports: { sealedResourceAuthorizationTransport: transport } }, 'GET')).toEqual({ statusCode: 200, body: { packages: [metadata] } });
    transport.listCloudPackages.mockResolvedValueOnce({ status: 503, body: { packages: [] } });
    expect(await route('/api/packages/installed', {}, { runtimeHostTransports: { sealedResourceAuthorizationTransport: transport } }, 'GET')).toEqual({ statusCode: 503, body: { packages: [] } });
  });

  it.each([403, 404, 409, 503])('preserves HTTP %s and structured cloud rejection', async (status) => {
    const code = 'MATCHA_PACKAGE_VERSION_NOT_PUBLISHABLE';
    const cloudAccountService = { publishPackage: vi.fn().mockRejectedValue(new CloudAccountClientError(status, code, 'not publishable', 'cloudEnvelopeRequired')) };
    const result = await route('/api/packages/v1/publish', {}, { cloudAccountService, runtimeHostTransports: {} });
    expect(result).toEqual({ statusCode: status, body: { success: false, error: 'not publishable', message: `${code}: not publishable`, code, reason: 'cloudEnvelopeRequired' } });
  });
});
